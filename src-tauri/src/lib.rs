use bytes::BytesMut;
use futures_util::StreamExt;
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use storage::{AppSettings, ConversationDetail, ConversationSummary, ExportPayload, MessageInput};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

mod storage;

const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
const STREAM_BATCH_WINDOW_MS: u64 = 24;
const STREAM_BATCH_MAX_BYTES: usize = 16 * 1024;
const STREAM_BATCHING_ENV: &str = "OLLMIN_STREAM_BATCHING";
const DEFAULT_CONTEXT_SIZE: u32 = 4096;
const DEFAULT_OUTPUT_TOKEN_LIMIT: u32 = 2048;

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
    sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
struct ChatDiagnosticEvent {
    request_id: String,
    phase: String,
    elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_byte_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_line_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_emit_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    final_emit_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes_received: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parsed_events: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    emitted_events: Option<u64>,
}

struct ActiveChat {
    request_id: String,
    cancellation: CancellationToken,
}

#[derive(Clone)]
struct ChatState {
    active: Arc<Mutex<Option<ActiveChat>>>,
    client: Client,
}

impl Default for ChatState {
    fn default() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
            client: Client::new(),
        }
    }
}

struct DatabaseState {
    connection: Mutex<rusqlite::Connection>,
}

#[derive(Default)]
struct PendingBatch {
    content: String,
    thinking: String,
    byte_len: usize,
    done: bool,
    response: Option<Value>,
    deadline: Option<Instant>,
}

impl PendingBatch {
    fn is_empty(&self) -> bool {
        self.content.is_empty() && self.thinking.is_empty() && !self.done && self.response.is_none()
    }

    fn append(&mut self, event: ChatStreamEvent) {
        self.byte_len += event.content.len() + event.thinking.len();
        self.content.push_str(&event.content);
        self.thinking.push_str(&event.thinking);
        if event.done {
            self.done = true;
            self.response = event.response;
        }
        if self.deadline.is_none() {
            self.deadline = Some(Instant::now() + Duration::from_millis(STREAM_BATCH_WINDOW_MS));
        }
    }

    fn should_flush(&self) -> bool {
        self.done || self.byte_len >= STREAM_BATCH_MAX_BYTES
    }

    fn take_event(&mut self, request_id: &str) -> Option<ChatStreamEvent> {
        if self.is_empty() {
            return None;
        }
        let event = ChatStreamEvent {
            request_id: request_id.to_string(),
            content: std::mem::take(&mut self.content),
            thinking: std::mem::take(&mut self.thinking),
            done: self.done,
            cancelled: false,
            sequence: None,
            error: None,
            response: self.response.take(),
        };
        self.byte_len = 0;
        self.done = false;
        self.deadline = None;
        Some(event)
    }
}

struct StreamDiagnostics {
    enabled: bool,
    request_id: String,
    started_at: Instant,
    first_byte_ms: Option<f64>,
    first_line_ms: Option<f64>,
    first_emit_ms: Option<f64>,
    final_emit_ms: Option<f64>,
    bytes_received: usize,
    parsed_events: u64,
    emitted_events: u64,
    next_sequence: u64,
}

impl StreamDiagnostics {
    fn new(request_id: String) -> Self {
        Self {
            enabled: diagnostics_enabled(),
            request_id,
            started_at: Instant::now(),
            first_byte_ms: None,
            first_line_ms: None,
            first_emit_ms: None,
            final_emit_ms: None,
            bytes_received: 0,
            parsed_events: 0,
            emitted_events: 0,
            next_sequence: 0,
        }
    }

    fn elapsed_ms(&self) -> f64 {
        self.started_at.elapsed().as_secs_f64() * 1000.0
    }
}

fn diagnostics_enabled() -> bool {
    match std::env::var("OLLMIN_DIAGNOSTICS") {
        Ok(value) => matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "on"),
        Err(_) => cfg!(debug_assertions),
    }
}

fn stream_batching_enabled() -> bool {
    match std::env::var(STREAM_BATCHING_ENV) {
        Ok(value) => !matches!(
            value.to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
        Err(_) => true,
    }
}

fn profile_for_mode(mode: &str) -> Result<GenerationProfile, String> {
    match mode {
        "fast" => Ok(GenerationProfile {
            think: false,
            num_ctx: 4096,
            num_predict: 2048,
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

fn override_context_size(
    profile: &mut GenerationProfile,
    context_size: Option<u32>,
) -> Result<(), String> {
    let context_size = context_size.unwrap_or(DEFAULT_CONTEXT_SIZE);
    if !matches!(context_size, 4096 | 8192 | 16384) {
        return Err("不支持的上下文大小，可选 4K、8K 或 16K".to_string());
    }
    profile.num_ctx = context_size;
    Ok(())
}

fn override_output_token_limit(
    profile: &mut GenerationProfile,
    output_token_limit: Option<u32>,
) -> Result<(), String> {
    let output_token_limit = output_token_limit.unwrap_or(DEFAULT_OUTPUT_TOKEN_LIMIT);
    if !matches!(output_token_limit, 1024 | 2048 | 4096) {
        return Err("不支持的输出 token 上限，可选 1K、2K 或 4K".to_string());
    }
    profile.num_predict = output_token_limit;
    Ok(())
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

async fn request_json(
    client: &Client,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
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

fn emit_diagnostic_phase(app: &AppHandle, diagnostics: &StreamDiagnostics, phase: &str) {
    if !diagnostics.enabled {
        return;
    }
    let _ = app.emit(
        "chat:diagnostic",
        ChatDiagnosticEvent {
            request_id: diagnostics.request_id.clone(),
            phase: phase.to_string(),
            elapsed_ms: diagnostics.elapsed_ms(),
            first_byte_ms: None,
            first_line_ms: None,
            first_emit_ms: None,
            final_emit_ms: None,
            bytes_received: None,
            parsed_events: None,
            emitted_events: None,
        },
    );
}

fn finish_diagnostics(app: &AppHandle, diagnostics: &StreamDiagnostics) {
    if !diagnostics.enabled {
        return;
    }
    let _ = app.emit(
        "chat:diagnostic",
        ChatDiagnosticEvent {
            request_id: diagnostics.request_id.clone(),
            phase: "summary".to_string(),
            elapsed_ms: diagnostics.elapsed_ms(),
            first_byte_ms: diagnostics.first_byte_ms,
            first_line_ms: diagnostics.first_line_ms,
            first_emit_ms: diagnostics.first_emit_ms,
            final_emit_ms: diagnostics.final_emit_ms,
            bytes_received: Some(diagnostics.bytes_received),
            parsed_events: Some(diagnostics.parsed_events),
            emitted_events: Some(diagnostics.emitted_events),
        },
    );
}

fn emit_stream_event(
    app: &AppHandle,
    mut event: ChatStreamEvent,
    diagnostics: &mut StreamDiagnostics,
) {
    if diagnostics.enabled {
        diagnostics.emitted_events += 1;
        diagnostics.next_sequence += 1;
        event.sequence = Some(diagnostics.next_sequence);
        let elapsed_ms = diagnostics.elapsed_ms();
        if diagnostics.first_emit_ms.is_none() {
            diagnostics.first_emit_ms = Some(elapsed_ms);
            emit_diagnostic_phase(app, diagnostics, "T3-emit");
        }
        if event.done {
            diagnostics.final_emit_ms = Some(elapsed_ms);
        }
    }
    emit_event(app, event);
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

fn emit_cancelled(app: &AppHandle, request_id: &str, diagnostics: &mut StreamDiagnostics) {
    emit_stream_event(
        app,
        ChatStreamEvent {
            request_id: request_id.to_string(),
            content: String::new(),
            thinking: String::new(),
            done: true,
            cancelled: true,
            sequence: None,
            error: None,
            response: None,
        },
        diagnostics,
    );
    finish_diagnostics(app, diagnostics);
}

fn emit_error(
    app: &AppHandle,
    request_id: &str,
    message: String,
    diagnostics: &mut StreamDiagnostics,
) {
    emit_stream_event(
        app,
        ChatStreamEvent {
            request_id: request_id.to_string(),
            content: String::new(),
            thinking: String::new(),
            done: true,
            cancelled: false,
            sequence: None,
            error: Some(message),
            response: None,
        },
        diagnostics,
    );
    finish_diagnostics(app, diagnostics);
}

fn stream_event_from_chunk(request_id: &str, chunk: OllamaStreamChunk) -> ChatStreamEvent {
    let done = chunk.done.unwrap_or(false);
    let response = if done {
        serde_json::to_value(&chunk).ok()
    } else {
        None
    };
    let (content, thinking) = chunk
        .message
        .map(|message| (message.content, message.thinking.unwrap_or_default()))
        .unwrap_or_default();
    ChatStreamEvent {
        request_id: request_id.to_string(),
        content,
        thinking,
        done,
        cancelled: false,
        sequence: None,
        error: None,
        response,
    }
}

fn queue_stream_chunk(
    request_id: &str,
    chunk: OllamaStreamChunk,
    pending: &mut PendingBatch,
    first_event_sent: bool,
    batching_enabled: bool,
) -> (bool, bool) {
    let event = stream_event_from_chunk(request_id, chunk);
    let done = event.done;
    let has_visible_delta = !event.content.is_empty() || !event.thinking.is_empty();
    if !done && !has_visible_delta {
        return (false, false);
    }
    pending.append(event);
    let should_flush = done
        || !batching_enabled
        || (!first_event_sent && has_visible_delta)
        || pending.should_flush();
    (done, should_flush)
}

fn flush_pending_batch(
    app: &AppHandle,
    request_id: &str,
    pending: &mut PendingBatch,
    diagnostics: &mut StreamDiagnostics,
) -> bool {
    let Some(event) = pending.take_event(request_id) else {
        return false;
    };
    emit_stream_event(app, event, diagnostics);
    true
}

fn parse_stream_line(line: &[u8]) -> Result<Option<OllamaStreamChunk>, String> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    serde_json::from_slice::<OllamaStreamChunk>(line)
        .map(Some)
        .map_err(|error| format!("无法解析 Ollama 流响应：{error}"))
}

async fn run_chat_stream(
    app: AppHandle,
    active: Arc<Mutex<Option<ActiveChat>>>,
    client: Client,
    request_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    profile: GenerationProfile,
    cancellation: CancellationToken,
) {
    let mut diagnostics = StreamDiagnostics::new(request_id.clone());
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

    emit_diagnostic_phase(&app, &diagnostics, "T2");
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            clear_active(&active, &request_id);
            emit_cancelled(&app, &request_id, &mut diagnostics);
            return;
        }
        result = client.post(format!("{OLLAMA_BASE_URL}/api/chat")).json(&body).send() => result
    };

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            clear_active(&active, &request_id);
            emit_error(
                &app,
                &request_id,
                format!("连接 Ollama 失败：{error}"),
                &mut diagnostics,
            );
            return;
        }
    };

    if response.status() != StatusCode::OK {
        let status = response.status();
        let detail = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                clear_active(&active, &request_id);
                emit_cancelled(&app, &request_id, &mut diagnostics);
                return;
            }
            result = response.text() => result.unwrap_or_default()
        };
        clear_active(&active, &request_id);
        emit_error(
            &app,
            &request_id,
            format!("Ollama 返回 {status}：{detail}"),
            &mut diagnostics,
        );
        return;
    }

    let mut stream = response.bytes_stream();
    let mut buffer = BytesMut::new();
    let mut pending = PendingBatch::default();
    let mut completed = false;
    let mut first_event_sent = false;
    let batching_enabled = stream_batching_enabled();

    'stream: loop {
        let next_chunk = if batching_enabled && pending.deadline.is_some() {
            let deadline = pending.deadline.expect("pending batch deadline");
            let delay = deadline.saturating_duration_since(Instant::now());
            let sleep = tokio::time::sleep(delay);
            tokio::pin!(sleep);
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                    clear_active(&active, &request_id);
                    emit_cancelled(&app, &request_id, &mut diagnostics);
                    return;
                }
                _ = &mut sleep => {
                    if flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics) {
                        first_event_sent = true;
                    }
                    continue;
                }
                next = stream.next() => next
            }
        } else {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    clear_active(&active, &request_id);
                    emit_cancelled(&app, &request_id, &mut diagnostics);
                    return;
                }
                next = stream.next() => next
            }
        };

        let Some(next_chunk) = next_chunk else { break };
        let bytes = match next_chunk {
            Ok(bytes) => bytes,
            Err(error) => {
                flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                clear_active(&active, &request_id);
                emit_error(
                    &app,
                    &request_id,
                    format!("读取 Ollama 流失败：{error}"),
                    &mut diagnostics,
                );
                return;
            }
        };
        diagnostics.bytes_received += bytes.len();
        if diagnostics.enabled && diagnostics.first_byte_ms.is_none() {
            diagnostics.first_byte_ms = Some(diagnostics.elapsed_ms());
            emit_diagnostic_phase(&app, &diagnostics, "T3-byte");
        }
        buffer.extend_from_slice(&bytes);

        while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
            if cancellation.is_cancelled() {
                flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                clear_active(&active, &request_id);
                emit_cancelled(&app, &request_id, &mut diagnostics);
                return;
            }
            let line = buffer.split_to(position + 1);
            let parsed = match parse_stream_line(&line) {
                Ok(parsed) => parsed,
                Err(error) => {
                    flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                    clear_active(&active, &request_id);
                    emit_error(&app, &request_id, error, &mut diagnostics);
                    return;
                }
            };
            let Some(chunk) = parsed else { continue };
            diagnostics.parsed_events += 1;
            if diagnostics.enabled && diagnostics.first_line_ms.is_none() {
                diagnostics.first_line_ms = Some(diagnostics.elapsed_ms());
                emit_diagnostic_phase(&app, &diagnostics, "T3-line");
            }
            let (done, should_flush) = queue_stream_chunk(
                &request_id,
                chunk,
                &mut pending,
                first_event_sent,
                batching_enabled,
            );
            if cancellation.is_cancelled() {
                flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                clear_active(&active, &request_id);
                emit_cancelled(&app, &request_id, &mut diagnostics);
                return;
            }
            if should_flush
                && flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics)
            {
                first_event_sent = true;
            }
            if done {
                clear_active(&active, &request_id);
                completed = true;
                break 'stream;
            }
        }
    }

    if cancellation.is_cancelled() {
        flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
        clear_active(&active, &request_id);
        emit_cancelled(&app, &request_id, &mut diagnostics);
        return;
    } else if !completed {
        if !buffer.iter().all(|byte| byte.is_ascii_whitespace()) {
            match parse_stream_line(&buffer) {
                Ok(Some(mut chunk)) => {
                    diagnostics.parsed_events += 1;
                    if diagnostics.enabled && diagnostics.first_line_ms.is_none() {
                        diagnostics.first_line_ms = Some(diagnostics.elapsed_ms());
                        emit_diagnostic_phase(&app, &diagnostics, "T3-line");
                    }
                    // Ollama normally terminates with a newline, but preserve
                    // the previous behavior when the final JSON line is not.
                    if !chunk.done.unwrap_or(false) {
                        chunk.done = Some(true);
                    }
                    let (done, should_flush) = queue_stream_chunk(
                        &request_id,
                        chunk,
                        &mut pending,
                        first_event_sent,
                        batching_enabled,
                    );
                    if cancellation.is_cancelled() {
                        flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                        clear_active(&active, &request_id);
                        emit_cancelled(&app, &request_id, &mut diagnostics);
                        return;
                    }
                    if should_flush {
                        flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                    }
                    completed = done;
                }
                Ok(None) => {}
                Err(error) => {
                    flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                    clear_active(&active, &request_id);
                    emit_error(&app, &request_id, error, &mut diagnostics);
                    return;
                }
            }
        }
        if !completed {
            flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
            clear_active(&active, &request_id);
            emit_error(
                &app,
                &request_id,
                "Ollama 流在完成前关闭".to_string(),
                &mut diagnostics,
            );
            return;
        }
    }
    finish_diagnostics(&app, &diagnostics);
    clear_active(&active, &request_id);
}

#[tauri::command]
async fn get_service_status(state: State<'_, ChatState>) -> Result<Value, String> {
    request_json(&state.client, Method::GET, "/api/version", None).await
}

#[tauri::command]
async fn get_models(state: State<'_, ChatState>) -> Result<Value, String> {
    request_json(&state.client, Method::GET, "/api/tags", None).await
}

#[tauri::command]
async fn get_loaded_models(state: State<'_, ChatState>) -> Result<Value, String> {
    request_json(&state.client, Method::GET, "/api/ps", None).await
}

#[tauri::command]
async fn warm_model(state: State<'_, ChatState>, model: String) -> Result<Value, String> {
    if model.trim().is_empty() {
        return Err("模型名称不能为空".to_string());
    }

    request_json(
        &state.client,
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
    state: State<'_, ChatState>,
    model: String,
    messages: Vec<ChatMessage>,
    mode: String,
    context_size: Option<u32>,
    output_token_limit: Option<u32>,
) -> Result<Value, String> {
    if model.trim().is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    let (messages, mut profile) = prepare_messages(messages, &mode)?;
    override_context_size(&mut profile, context_size)?;
    override_output_token_limit(&mut profile, output_token_limit)?;

    request_json(
        &state.client,
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
    context_size: Option<u32>,
    output_token_limit: Option<u32>,
) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("请求 ID 不能为空".to_string());
    }
    if model.trim().is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    let (messages, mut profile) = prepare_messages(messages, &mode)?;
    override_context_size(&mut profile, context_size)?;
    override_output_token_limit(&mut profile, output_token_limit)?;
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
    let client = state.client.clone();
    tauri::async_runtime::spawn(run_chat_stream(
        app,
        active,
        client,
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

#[cfg(test)]
mod tests {
    use super::{
        cancel_active, override_context_size, override_output_token_limit, parse_stream_line,
        profile_for_mode, queue_stream_chunk, trim_fast_history, ActiveChat, ChatMessage,
        OllamaStreamChunk, PendingBatch, STREAM_BATCH_MAX_BYTES,
    };
    use bytes::BytesMut;
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
        assert_eq!(profile.num_predict, 2048);
        assert_eq!(profile.max_history_tokens, 2048);
    }

    #[test]
    fn context_size_override_replaces_mode_default() {
        let mut profile = profile_for_mode("reasoning").expect("reasoning profile");
        override_context_size(&mut profile, Some(4096)).expect("override context size");
        assert_eq!(profile.num_ctx, 4096);

        override_context_size(&mut profile, Some(16384)).expect("override context size");
        assert_eq!(profile.num_ctx, 16384);
        assert!(override_context_size(&mut profile, Some(12345)).is_err());
    }

    #[test]
    fn output_token_limit_override_replaces_mode_default() {
        let mut profile = profile_for_mode("balanced").expect("balanced profile");
        assert_eq!(profile.num_predict, 768);

        override_output_token_limit(&mut profile, Some(1024)).expect("override output limit");
        assert_eq!(profile.num_predict, 1024);

        override_output_token_limit(&mut profile, Some(4096)).expect("override output limit");
        assert_eq!(profile.num_predict, 4096);
        assert!(override_output_token_limit(&mut profile, Some(12345)).is_err());
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
    fn parser_accepts_crlf_and_ignores_blank_lines() {
        assert!(parse_stream_line(b"\r\n")
            .expect("blank line is valid")
            .is_none());
        let mut line = br#"{"message":{"role":"assistant","content":"A"},"done":false}"#.to_vec();
        line.extend_from_slice(b"\r\n");
        let chunk = parse_stream_line(&line)
            .expect("valid CRLF NDJSON")
            .expect("non-empty chunk");
        assert_eq!(chunk.message.expect("message").content, "A");
    }

    #[test]
    fn parser_rejects_malformed_json() {
        let error = parse_stream_line(br#"{"message":"broken"}"#).expect_err("invalid shape");
        assert!(error.contains("无法解析 Ollama 流响应"));
    }

    #[test]
    fn bytes_mut_reassembles_fragmented_ndjson_line() {
        let mut buffer = BytesMut::new();
        buffer.extend_from_slice(br#"{"message":{"role":"assistant","content":"hel"#);
        assert!(buffer.iter().position(|byte| *byte == b'\n').is_none());
        buffer.extend_from_slice(br#"lo"},"done":false}"#);
        buffer.extend_from_slice(b"\r\n");
        let position = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .expect("complete line");
        let line = buffer.split_to(position + 1);
        let chunk = parse_stream_line(&line)
            .expect("valid reassembled NDJSON")
            .expect("non-empty chunk");
        assert_eq!(chunk.message.expect("message").content, "hello");
        assert!(buffer.is_empty());
    }

    #[test]
    fn bytes_mut_splits_multiple_lines_from_one_chunk() {
        let mut buffer = BytesMut::from(
            &br#"{"message":{"role":"assistant","content":"A"},"done":false}
{"message":{"role":"assistant","content":""},"done":true}
"#[..],
        );
        let mut parsed = Vec::new();
        while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
            let line = buffer.split_to(position + 1);
            if let Some(chunk) = parse_stream_line(&line).expect("valid NDJSON") {
                parsed.push(chunk);
            }
        }
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].message.as_ref().expect("message").content, "A");
        assert_eq!(parsed[1].done, Some(true));
        assert!(buffer.is_empty());
    }

    fn stream_chunk(content: &str, thinking: Option<&str>, done: bool) -> OllamaStreamChunk {
        OllamaStreamChunk {
            message: Some(ChatMessage {
                role: "assistant".to_string(),
                content: content.to_string(),
                thinking: thinking.map(str::to_string),
            }),
            done: Some(done),
            ..OllamaStreamChunk::default()
        }
    }

    #[test]
    fn pending_batch_flushes_first_delta_and_merges_terminal_delta() {
        let mut pending = PendingBatch::default();
        let (done, should_flush) = queue_stream_chunk(
            "request-a",
            stream_chunk("hello", None, false),
            &mut pending,
            false,
            true,
        );
        assert!(!done);
        assert!(should_flush, "首个可见分片必须立即发送");
        let first = pending.take_event("request-a").expect("first batch");
        assert_eq!(first.content, "hello");
        assert!(!first.done);

        let (done, should_flush) = queue_stream_chunk(
            "request-a",
            stream_chunk(" world", Some("plan"), false),
            &mut pending,
            true,
            true,
        );
        assert!(!done);
        assert!(!should_flush, "小分片应等待时间窗合并");

        let mut terminal = stream_chunk("!", None, true);
        terminal.eval_count = Some(3);
        let (done, should_flush) =
            queue_stream_chunk("request-a", terminal, &mut pending, true, true);
        assert!(done);
        assert!(should_flush, "终止分片必须强制 flush");
        let final_event = pending.take_event("request-a").expect("terminal batch");
        assert_eq!(final_event.content, " world!");
        assert_eq!(final_event.thinking, "plan");
        assert!(final_event.done);
        assert_eq!(
            final_event.response.expect("terminal response")["eval_count"],
            3
        );
    }

    #[test]
    fn pending_batch_flushes_when_byte_limit_is_reached() {
        let mut pending = PendingBatch::default();
        let (_, first_flush) = queue_stream_chunk(
            "request-a",
            stream_chunk("a", None, false),
            &mut pending,
            true,
            true,
        );
        assert!(!first_flush);
        let large_delta = "b".repeat(STREAM_BATCH_MAX_BYTES);
        let (_, size_flush) = queue_stream_chunk(
            "request-a",
            stream_chunk(&large_delta, None, false),
            &mut pending,
            true,
            true,
        );
        assert!(size_flush);
        let event = pending.take_event("request-a").expect("size-limited batch");
        assert_eq!(event.content.len(), STREAM_BATCH_MAX_BYTES + 1);
    }

    #[test]
    fn pending_batch_can_disable_coalescing_for_debug_ab() {
        let mut pending = PendingBatch::default();
        let (_, should_flush) = queue_stream_chunk(
            "request-a",
            stream_chunk("a", None, false),
            &mut pending,
            true,
            false,
        );
        assert!(should_flush);
        assert_eq!(
            pending
                .take_event("request-a")
                .expect("unbatched event")
                .content,
            "a"
        );
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
