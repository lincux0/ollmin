use super::platform::contracts::{ChatOptions, ChatRequest};
use super::platform::runtime::OLLAMA_KEEP_ALIVE;
use super::*;

const MAX_LOCAL_PATH_CHARACTERS: usize = 4_096;

fn validate_attachment_ids(ids: &[String]) -> Result<(), String> {
    if ids.len() > attachments::MAX_ATTACHMENT_COUNT {
        return Err(format!(
            "一次最多处理 {} 个附件",
            attachments::MAX_ATTACHMENT_COUNT
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if id.trim().is_empty()
            || id.chars().count() > 128
            || id
                .chars()
                .any(|character| character == '\0' || character.is_control())
        {
            return Err("附件 ID 无效".to_string());
        }
        if !seen.insert(id) {
            return Err("附件 ID 不能重复".to_string());
        }
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 128
        || value
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(format!("{label}无效"));
    }
    Ok(())
}

#[tauri::command]
async fn get_service_status(state: State<'_, ChatState>) -> Result<Value, String> {
    state.runtime.health().await
}

#[tauri::command]
async fn get_models(state: State<'_, ChatState>) -> Result<Value, String> {
    state.runtime.list_models().await
}

#[tauri::command]
async fn parse_local_attachments(
    attachment_state: State<'_, AttachmentState>,
    paths: Vec<String>,
) -> Result<Vec<attachments::AttachmentSummary>, String> {
    if paths.len() > attachments::MAX_ATTACHMENT_COUNT {
        return Err(format!(
            "一次最多添加 {} 个文件",
            attachments::MAX_ATTACHMENT_COUNT
        ));
    }
    if paths
        .iter()
        .any(|path| path.chars().count() > MAX_LOCAL_PATH_CHARACTERS || path.contains('\0'))
    {
        return Err(format!(
            "本地文件路径不能超过 {MAX_LOCAL_PATH_CHARACTERS} 个字符且不能包含空字符"
        ));
    }
    let parsed = tauri::async_runtime::spawn_blocking(move || attachments::parse_paths(paths))
        .await
        .map_err(|error| format!("本地文件解析任务异常结束：{error}"))??;
    let summaries = parsed
        .iter()
        .map(|attachment| attachment.summary.clone())
        .collect::<Vec<_>>();
    let mut cache = attachment_state
        .parsed
        .lock()
        .map_err(|_| "无法获取本地附件缓存锁".to_string())?;
    for attachment in parsed {
        cache.insert(attachment.summary.id.clone(), attachment);
    }
    Ok(summaries)
}

#[tauri::command]
fn save_conversation_attachments(
    database: State<'_, DatabaseState>,
    attachment_state: State<'_, AttachmentState>,
    conversation_id: String,
    message_id: String,
    attachment_ids: Vec<String>,
) -> Result<(), String> {
    validate_conversation_id(&conversation_id)?;
    validate_identifier(&message_id, "消息 ID")?;
    validate_attachment_ids(&attachment_ids)?;
    if attachment_ids.is_empty() {
        return Ok(());
    }
    let connection = database
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    let existing =
        storage::existing_attachment_ids(&connection, &conversation_id, &attachment_ids)?;
    let mut cache = attachment_state
        .parsed
        .lock()
        .map_err(|_| "无法获取本地附件缓存锁".to_string())?;
    let additions = attachment_ids
        .iter()
        .filter(|id| !existing.iter().any(|saved| saved == *id))
        .map(|id| {
            cache
                .get(id)
                .cloned()
                .ok_or_else(|| "附件解析结果已失效，请重新添加后再发送".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    storage::save_conversation_attachments(&connection, &conversation_id, &message_id, &additions)?;
    remove_cached_ids(&mut cache, &attachment_ids);
    Ok(())
}

#[tauri::command]
fn release_local_attachments(
    attachment_state: State<'_, AttachmentState>,
    attachment_ids: Vec<String>,
) -> Result<(), String> {
    validate_attachment_ids(&attachment_ids)?;
    attachment_state.release(&attachment_ids)
}

#[tauri::command]
fn remove_conversation_attachment(
    database: State<'_, DatabaseState>,
    conversation_id: String,
    attachment_id: String,
) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::remove_conversation_attachment(&connection, &conversation_id, &attachment_id)
}

#[tauri::command]
async fn get_loaded_models(state: State<'_, ChatState>) -> Result<Value, String> {
    state.runtime.loaded_models().await
}

#[tauri::command]
async fn warm_model(state: State<'_, ChatState>, model: String) -> Result<Value, String> {
    let model = validate_model_name(&model)?;
    state.runtime.warm_model(model).await
}

#[tauri::command]
async fn diagnose_chat(
    state: State<'_, ChatState>,
    model: String,
    messages: Vec<ChatMessage>,
    mode: String,
    context_size: Option<u32>,
    output_token_limit: Option<u32>,
    reasoning_token_limit: Option<u32>,
) -> Result<Value, String> {
    let model = validate_model_name(&model)?;
    let (messages, mut profile) = prepare_messages(messages, &mode)?;
    override_context_size(&mut profile, context_size)?;
    override_output_token_limit(&mut profile, output_token_limit)?;
    override_reasoning_token_limit(&mut profile, reasoning_token_limit)?;

    let body = serde_json::to_value(ChatRequest {
        model,
        messages,
        stream: false,
        think: profile.think,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: ChatOptions {
            num_ctx: profile.num_ctx,
            num_predict: profile.num_predict,
            temperature: 0.7,
        },
    })
    .map_err(|error| format!("序列化 Ollama 聊天请求失败：{error}"))?;

    state.runtime.chat_once(body).await
}

#[tauri::command]
async fn start_chat(
    app: AppHandle,
    state: State<'_, ChatState>,
    database: State<'_, DatabaseState>,
    request_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    mode: String,
    context_size: Option<u32>,
    output_token_limit: Option<u32>,
    reasoning_token_limit: Option<u32>,
    conversation_id: String,
    attachment_ids: Vec<String>,
) -> Result<(), String> {
    let request_id = validate_request_id(&request_id)?;
    let model = validate_model_name(&model)?;
    let conversation_id = validate_conversation_id(&conversation_id)?;
    validate_attachment_ids(&attachment_ids)?;
    let (messages, mut profile) = prepare_messages(messages, &mode)?;
    override_context_size(&mut profile, context_size)?;
    override_output_token_limit(&mut profile, output_token_limit)?;
    override_reasoning_token_limit(&mut profile, reasoning_token_limit)?;
    let messages = if attachment_ids.is_empty() {
        messages
    } else {
        let connection = database
            .connection
            .lock()
            .map_err(|_| "无法获取本地数据库锁".to_string())?;
        let attachments =
            storage::load_attachment_payloads(&connection, &conversation_id, &attachment_ids)?;
        inject_attachment_context(messages, &mode, &profile, &attachments)?
    };
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
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn(run_chat_stream(
        app,
        active,
        runtime,
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
    let request_id = validate_request_id(&request_id)?;
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
    model_alias: Option<String>,
) -> Result<ConversationDetail, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::create_conversation_with_alias(
        &connection,
        &id,
        &model,
        model_alias.as_deref(),
        &mode,
        title.as_deref(),
    )
}

#[tauri::command]
fn create_conversation_with_message(
    state: State<'_, DatabaseState>,
    id: String,
    model: String,
    mode: String,
    title: Option<String>,
    model_alias: Option<String>,
    message: MessageInput,
) -> Result<ConversationDetail, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "无法获取本地数据库锁".to_string())?;
    storage::create_conversation_with_message_alias(
        &mut connection,
        &id,
        &model,
        model_alias.as_deref(),
        &mode,
        title.as_deref(),
        message,
    )
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
        .plugin(tauri_plugin_dialog::init())
        .manage(ChatState::default())
        .manage(AttachmentState::default())
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
            parse_local_attachments,
            save_conversation_attachments,
            release_local_attachments,
            remove_conversation_attachment,
            get_loaded_models,
            warm_model,
            diagnose_chat,
            start_chat,
            stop_chat,
            list_conversations,
            create_conversation,
            create_conversation_with_message,
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
