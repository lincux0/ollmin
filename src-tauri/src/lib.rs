use futures_util::StreamExt;
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use storage::{AppSettings, ConversationDetail, ConversationSummary, ExportPayload, MessageInput};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

mod storage;

const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct GenerationProfile {
    think: bool,
    num_ctx: u32,
    num_predict: u32,
    max_history_tokens: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct OllamaStreamChunk {
    model: Option<String>,
    created_at: Option<String>,
    message: Option<ChatMessage>,
    done: Option<bool>,
    done_reason: Option<String>,
    total_duration: Option<u64>,
    load_duration: Option<u64>,
    prompt_eval_count: Option<u64>,
    prompt_eval_duration: Option<u64>,
    eval_count: Option<u64>,
    eval_duration: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct ChatStreamEvent {
    request_id: String,
    content: String,
    thinking: String,
    done: bool,
    cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<Value>,
}

struct ActiveChat {
    request_id: String,
    cancellation: CancellationToken,
}

#[derive(Clone, Default)]
struct ChatState {
    active: Arc<Mutex<Option<ActiveChat>>>,
}

struct DatabaseState {
    connection: Mutex<rusqlite::Connection>,
}

fn profile_for_mode(mode: &str) -> Result<GenerationProfile, String> {
    match mode {
        "fast" => Ok(GenerationProfile {
            think: false,
            num_ctx: 4096,
            num_predict: 384,
            max_history_tokens: 2048,
        }),
        "balanced" => Ok(GenerationProfile {
            think: true,
            num_ctx: 4096,
            num_predict: 768,
            max_history_tokens: 3072,
        }),
        "reasoning" => Ok(GenerationProfile {
            think: true,
            num_ctx: 8192,
            num_predict: 2048,
            max_history_tokens: 6144,
        }),
        _ => Err(format!("不支持的性能模式：{mode}")),
    }
}

fn estimate_tokens(message: &ChatMessage) -> usize {
    (message.content.chars().count() * 2 / 7).max(1) + 4
}

fn trim_fast_history(messages: &[ChatMessage], max_tokens: usize) -> Vec<ChatMessage> {
    if messages.is_empty() {
        return Vec::new();
    }

    let system_messages: Vec<ChatMessage> = messages
        .iter()
        .filter(|message| message.role == "system")
        .cloned()
        .collect();
    let conversation: Vec<ChatMessage> = messages
        .iter()
        .filter(|message| message.role != "system")
        .cloned()
        .collect();
    let latest = conversation.last().cloned();
    let prior = if conversation.is_empty() {
        &[][..]
    } else {
        &conversation[..conversation.len() - 1]
    };

    let mut turns: Vec<Vec<ChatMessage>> = Vec::new();
    let mut current_turn: Vec<ChatMessage> = Vec::new();
    for message in prior {
        if message.role == "user" && !current_turn.is_empty() {
            turns.push(current_turn);
            current_turn = Vec::new();
        }
        current_turn.push(message.clone());
    }
    if !current_turn.is_empty() {
        turns.push(current_turn);
    }

    let mut selected_turns: Vec<Vec<ChatMessage>> = Vec::new();
    let mut estimated_tokens: usize = system_messages.iter().map(estimate_tokens).sum();
    if let Some(message) = &latest {
        estimated_tokens += estimate_tokens(message);
    }

    for turn in turns.into_iter().rev() {
        let turn_tokens: usize = turn.iter().map(estimate_tokens).sum();
        if estimated_tokens + turn_tokens <= max_tokens {
            estimated_tokens += turn_tokens;
            selected_turns.push(turn);
        }
    }
    selected_turns.reverse();

    let mut trimmed = system_messages;
    for turn in selected_turns {
        trimmed.extend(turn);
    }
    if let Some(message) = latest {
        trimmed.push(message);
    }
    trimmed
}

fn prepare_messages(
    messages: Vec<ChatMessage>,
    mode: &str,
) -> Result<(Vec<ChatMessage>, GenerationProfile), String> {
    if messages.is_empty()
        || messages
            .iter()
            .all(|message| message.content.trim().is_empty())
    {
        return Err("消息不能为空".to_string());
    }
    let profile = profile_for_mode(mode)?;
    let prepared = if mode == "fast" {
        trim_fast_history(&messages, profile.max_history_tokens)
    } else {
        messages
    };
    Ok((prepared, profile))
}

async fn request_json(method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let client = Client::new();
    let url = format!("{OLLAMA_BASE_URL}{path}");
    let mut request = client.request(method, url);
    if let Some(payload) = body {
        request = request.json(&payload);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|error| format!("读取 Ollama 响应失败：{error}"))?;

    if status != StatusCode::OK {
        let detail = if response_text.trim().is_empty() {
            status.to_string()
        } else {
            response_text
        };
        return Err(format!("Ollama 返回 {status}：{detail}"));
    }

    serde_json::from_str(&response_text)
        .map_err(|error| format!("Ollama 返回了无法解析的 JSON：{error}"))
}

fn emit_event(app: &AppHandle, event: ChatStreamEvent) {
    let _ = app.emit("chat:chunk", event);
}

fn clear_active(active: &Arc<Mutex<Option<ActiveChat>>>, request_id: &str) {
    if let Ok(mut current) = active.lock() {
        if current
            .as_ref()
            .map(|item| item.request_id == request_id)
            .unwrap_or(false)
        {
            *current = None;
        }
    }
}

fn cancel_active(
    active: &Arc<Mutex<Option<ActiveChat>>>,
    request_id: &str,
) -> Result<bool, String> {
    let current = active
        .lock()
        .map_err(|_| "无法获取聊天调度器锁".to_string())?;
    if let Some(item) = current.as_ref() {
        if item.request_id == request_id {
            item.cancellation.cancel();
            return Ok(true);
        }
    }
    Ok(false)
}

fn emit_cancelled(app: &AppHandle, request_id: &str) {
    emit_event(
        app,
        ChatStreamEvent {
            request_id: request_id.to_string(),
            content: String::new(),
            thinking: String::new(),
            done: true,
            cancelled: true,
            error: None,
            response: None,
        },
    );
}

fn emit_error(app: &AppHandle, request_id: &str, message: String) {
    emit_event(
        app,
        ChatStreamEvent {
            request_id: request_id.to_string(),
            content: String::new(),
            thinking: String::new(),
            done: true,
            cancelled: false,
            error: Some(message),
            response: None,
        },
    );
}

fn parse_stream_line(line: &[u8]) -> Result<Option<OllamaStreamChunk>, String> {
    let text = String::from_utf8_lossy(line).trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<OllamaStreamChunk>(&text)
        .map(Some)
        .map_err(|error| format!("无法解析 Ollama 流响应：{error}"))
}

async fn run_chat_stream(
    app: AppHandle,
    active: Arc<Mutex<Option<ActiveChat>>>,
    request_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    profile: GenerationProfile,
    cancellation: CancellationToken,
) {
    let client = Client::new();
    let body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "think": profile.think,
        "keep_alive": "30m",
        "options": {
            "num_ctx": profile.num_ctx,
            "num_predict": profile.num_predict,
            "temperature": 0.7
        }
    });

    let response = tokio::select! {
        _ = cancellation.cancelled() => {
            clear_active(&active, &request_id);
            emit_cancelled(&app, &request_id);
            return;
        }
        result = client.post(format!("{OLLAMA_BASE_URL}/api/chat")).json(&body).send() => result
    };

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            clear_active(&active, &request_id);
            emit_error(&app, &request_id, format!("连接 Ollama 失败：{error}"));
            return;
        }
    };

    if response.status() != StatusCode::OK {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        clear_active(&active, &request_id);
        emit_error(&app, &request_id, format!("Ollama 返回 {status}：{detail}"));
        return;
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut completed = false;

    'stream: loop {
        let next_chunk = tokio::select! {
            _ = cancellation.cancelled() => {
                clear_active(&active, &request_id);
                emit_cancelled(&app, &request_id);
                return;
            }
            next = stream.next() => next
        };

        let Some(next_chunk) = next_chunk else { break };
        let bytes = match next_chunk {
            Ok(bytes) => bytes,
            Err(error) => {
                clear_active(&active, &request_id);
                emit_error(&app, &request_id, format!("读取 Ollama 流失败：{error}"));
                return;
            }
        };
        buffer.extend_from_slice(&bytes);

        while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=position).collect();
            let parsed = match parse_stream_line(&line) {
                Ok(parsed) => parsed,
                Err(error) => {
                    clear_active(&active, &request_id);
                    emit_error(&app, &request_id, error);
                    return;
                }
            };
            let Some(chunk) = parsed else { continue };
            let message = chunk.message.clone().unwrap_or(ChatMessage {
                role: "assistant".to_string(),
                content: String::new(),
                thinking: None,
            });
            let done = chunk.done.unwrap_or(false);
            let event = ChatStreamEvent {
                request_id: request_id.clone(),
                content: message.content,
                thinking: message.thinking.unwrap_or_default(),
                done,
                cancelled: false,
                error: None,
                response: if done {
                    serde_json::to_value(&chunk).ok()
                } else {
                    None
                },
            };
            if done {
                clear_active(&active, &request_id);
                emit_event(&app, event);
                completed = true;
                break 'stream;
            }
            emit_event(&app, event);
        }
    }

    if cancellation.is_cancelled() {
        clear_active(&active, &request_id);
        emit_cancelled(&app, &request_id);
    } else if !completed {
        if !buffer.iter().all(|byte| byte.is_ascii_whitespace()) {
            match parse_stream_line(&buffer) {
                Ok(Some(chunk)) => {
                    let message = chunk.message.clone().unwrap_or(ChatMessage {
                        role: "assistant".to_string(),
                        content: String::new(),
                        thinking: None,
                    });
                    clear_active(&active, &request_id);
                    emit_event(
                        &app,
                        ChatStreamEvent {
                            request_id: request_id.clone(),
                            content: message.content,
                            thinking: message.thinking.unwrap_or_default(),
                            done: true,
                            cancelled: false,
                            error: None,
                            response: serde_json::to_value(&chunk).ok(),
                        },
                    );
                    completed = true;
                }
                Ok(None) => {}
                Err(error) => {
                    clear_active(&active, &request_id);
                    emit_error(&app, &request_id, error);
                    return;
                }
            }
        }
        if !completed {
            clear_active(&active, &request_id);
            emit_error(&app, &request_id, "Ollama 流在完成前关闭".to_string());
        }
    }
    clear_active(&active, &request_id);
}

#[tauri::command]
async fn get_service_status() -> Result<Value, String> {
    request_json(Method::GET, "/api/version", None).await
}

#[tauri::command]
async fn get_models() -> Result<Value, String> {
    request_json(Method::GET, "/api/tags", None).await
}

#[tauri::command]
async fn get_loaded_models() -> Result<Value, String> {
    request_json(Method::GET, "/api/ps", None).await
}

#[tauri::command]
async fn warm_model(model: String) -> Result<Value, String> {
    if model.trim().is_empty() {
        return Err("模型名称不能为空".to_string());
    }

    request_json(
        Method::POST,
        "/api/generate",
        Some(json!({
            "model": model,
            "prompt": "",
            "stream": false,
            "keep_alive": "30m"
        })),
    )
    .await
}

#[tauri::command]
async fn diagnose_chat(
    model: String,
    messages: Vec<ChatMessage>,
    mode: String,
) -> Result<Value, String> {
    if model.trim().is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    let (messages, profile) = prepare_messages(messages, &mode)?;

    request_json(
        Method::POST,
        "/api/chat",
        Some(json!({
            "model": model,
            "messages": messages,
            "stream": false,
            "think": profile.think,
            "keep_alive": "30m",
            "options": {
                "num_ctx": profile.num_ctx,
                "num_predict": profile.num_predict,
                "temperature": 0.7
            }
        })),
    )
    .await
}

#[tauri::command]
async fn start_chat(
    app: AppHandle,
    state: State<'_, ChatState>,
    request_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    mode: String,
) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("请求 ID 不能为空".to_string());
    }
    if model.trim().is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    let (messages, profile) = prepare_messages(messages, &mode)?;
    let cancellation = CancellationToken::new();

    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "无法获取聊天调度器锁".to_string())?;
        if active.is_some() {
            return Err("已有请求正在生成，请先停止当前请求".to_string());
        }
        *active = Some(ActiveChat {
            request_id: request_id.clone(),
            cancellation: cancellation.clone(),
        });
    }

    let active = state.active.clone();
    tauri::async_runtime::spawn(run_chat_stream(
        app,
        active,
        request_id,
        model,
        messages,
        profile,
        cancellation,
    ));
    Ok(())
}

#[tauri::command]
fn stop_chat(state: State<'_, ChatState>, request_id: String) -> Result<bool, String> {
    cancel_active(&state.active, &request_id)
}

#[tauri::command]
fn list_conversations(
    state: State<'_, DatabaseState>,
    query: Option<String>,
) -> Result<Vec<ConversationSummary>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::list_conversations(&connection, query.as_deref())
}

#[tauri::command]
fn create_conversation(
    state: State<'_, DatabaseState>,
    id: String,
    model: String,
    mode: String,
    title: Option<String>,
) -> Result<ConversationDetail, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::create_conversation(&connection, &id, &model, &mode, title.as_deref())
}

#[tauri::command]
fn get_conversation(
    state: State<'_, DatabaseState>,
    conversation_id: String,
) -> Result<ConversationDetail, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::get_conversation(&connection, &conversation_id)
}

#[tauri::command]
fn rename_conversation(
    state: State<'_, DatabaseState>,
    conversation_id: String,
    title: String,
) -> Result<ConversationSummary, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::rename_conversation(&connection, &conversation_id, &title)
}

#[tauri::command]
fn delete_conversation(
    state: State<'_, DatabaseState>,
    conversation_id: String,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::delete_conversation(&connection, &conversation_id)
}

#[tauri::command]
fn save_message(state: State<'_, DatabaseState>, message: MessageInput) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::save_message(&connection, message)
}

#[tauri::command]
fn get_settings(state: State<'_, DatabaseState>) -> Result<AppSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::get_settings(&connection)
}

#[tauri::command]
fn update_settings(
    state: State<'_, DatabaseState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::update_settings(&connection, settings)
}

#[tauri::command]
fn clear_conversations(state: State<'_, DatabaseState>) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::clear_conversations(&connection)
}

#[tauri::command]
fn export_conversation(
    state: State<'_, DatabaseState>,
    conversation_id: String,
    format: String,
) -> Result<ExportPayload, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::export_conversation(&connection, &conversation_id, &format)
}

pub fn run() {
    tauri::Builder::default()
        .manage(ChatState::default())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(format!("获取应用数据目录失败：{error}")))?;
            let database_path = app_data_dir.join("ollmin.sqlite3");
            let connection = storage::open_database(&database_path)
                .map_err(|error| std::io::Error::other(error))?;
            app.manage(DatabaseState {
                connection: Mutex::new(connection),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_service_status,
            get_models,
            get_loaded_models,
            warm_model,
            diagnose_chat,
            start_chat,
            stop_chat,
            list_conversations,
            create_conversation,
            get_conversation,
            rename_conversation,
            delete_conversation,
            save_message,
            get_settings,
            update_settings,
            clear_conversations,
            export_conversation
        ])
        .run(tauri::generate_context!())
        .expect("运行 Ollmin 失败");
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_active, parse_stream_line, profile_for_mode, trim_fast_history, ActiveChat,
        ChatMessage,
    };
    use std::sync::{Arc, Mutex};
    use tokio_util::sync::CancellationToken;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
            thinking: None,
        }
    }

    #[test]
    fn fast_profile_disables_thinking_and_bounds_generation() {
        let profile = profile_for_mode("fast").expect("fast profile");
        assert!(!profile.think);
        assert_eq!(profile.num_ctx, 4096);
        assert_eq!(profile.num_predict, 384);
        assert_eq!(profile.max_history_tokens, 2048);
    }

    #[test]
    fn fast_history_keeps_latest_message_without_orphaning_old_turns() {
        let messages = vec![
            message("system", "Be concise."),
            message("user", &"old question ".repeat(80)),
            message("assistant", &"old answer ".repeat(80)),
            message("user", "current question"),
        ];
        let trimmed = trim_fast_history(&messages, 40);
        assert_eq!(trimmed.len(), 2);
        assert_eq!(trimmed[0].role, "system");
        assert_eq!(trimmed[1].content, "current question");
    }

    #[test]
    fn parses_ollama_ndjson_done_chunk() {
        let chunk = parse_stream_line(
            br#"{"model":"qwen3:4b-q4_K_M","message":{"role":"assistant","content":"OK"},"done":true,"eval_count":2}"#,
        )
        .expect("valid NDJSON")
        .expect("non-empty chunk");
        assert_eq!(chunk.message.expect("message").content, "OK");
        assert_eq!(chunk.done, Some(true));
        assert_eq!(chunk.eval_count, Some(2));
    }

    #[test]
    fn cancellation_only_targets_matching_request() {
        let token = CancellationToken::new();
        let active = Arc::new(Mutex::new(Some(ActiveChat {
            request_id: "request-a".to_string(),
            cancellation: token.clone(),
        })));
        assert!(!cancel_active(&active, "request-b").expect("lock"));
        assert!(!token.is_cancelled());
        assert!(cancel_active(&active, "request-a").expect("lock"));
        assert!(token.is_cancelled());
    }
}
