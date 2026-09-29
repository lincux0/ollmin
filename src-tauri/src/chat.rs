use super::platform::contracts::{ChatOptions, ChatRequest};
use super::platform::runtime::{
    read_response_text_limited, ModelRuntime, MAX_ERROR_RESPONSE_BYTES, OLLAMA_KEEP_ALIVE,
};
use super::*;
use bytes::BytesMut;
use futures_util::StreamExt;
use reqwest::StatusCode;

pub(crate) const MAX_MODEL_NAME_CHARACTERS: usize = 128;
pub(crate) const MAX_REQUEST_ID_CHARACTERS: usize = 128;
pub(crate) const MAX_CONVERSATION_ID_CHARACTERS: usize = 128;
const MAX_MESSAGES: usize = 128;
const MAX_MESSAGE_CONTENT_CHARACTERS: usize = 64 * 1024;
const MAX_MESSAGE_THINKING_CHARACTERS: usize = 64 * 1024;
const MAX_MESSAGE_TOTAL_BYTES: usize = 512 * 1024;
const MAX_STREAM_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_STREAM_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_STREAM_CONTENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_STREAM_THINKING_BYTES: usize = 8 * 1024 * 1024;
const MAX_GENERATION_TOKENS: i32 = 16_384;

pub(crate) fn diagnostics_enabled() -> bool {
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

pub(crate) fn profile_for_mode(mode: &str) -> Result<GenerationProfile, String> {
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

pub(crate) fn override_context_size(
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

// Ollama exposes one `num_predict` budget for both thinking and final content.
// We therefore reserve the selected message budget first, then add a finite
// reasoning budget. The UI's “不限” option still has this hard safety ceiling;
// no IPC input can request an unbounded Ollama response.
pub(crate) fn override_output_token_limit(
    profile: &mut GenerationProfile,
    output_token_limit: Option<u32>,
) -> Result<(), String> {
    let Some(output_token_limit) = output_token_limit else {
        return Ok(());
    };
    if !matches!(output_token_limit, 1024 | 2048 | 4096) {
        return Err("不支持的输出消息 token 上限，可选 1K、2K 或 4K".to_string());
    }
    profile.num_predict = output_token_limit as i32;
    Ok(())
}

pub(crate) fn override_reasoning_token_limit(
    profile: &mut GenerationProfile,
    reasoning_token_limit: Option<u32>,
) -> Result<(), String> {
    let Some(reasoning_token_limit) = reasoning_token_limit else {
        return Ok(());
    };
    if !matches!(reasoning_token_limit, 0 | 2048 | 4096 | 8192) {
        return Err("不支持的推理输出 token 上限，可选 2K、4K、8K 或不限".to_string());
    }
    if profile.think {
        profile.num_predict = if reasoning_token_limit == 0 {
            MAX_GENERATION_TOKENS
        } else {
            profile
                .num_predict
                .checked_add(reasoning_token_limit as i32)
                .ok_or_else(|| "推理与输出 token 上限之和过大".to_string())?
        };
        if profile.num_predict > MAX_GENERATION_TOKENS {
            return Err(format!(
                "推理与输出 token 上限之和不能超过 {}",
                MAX_GENERATION_TOKENS
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_model_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    if value.chars().count() > MAX_MODEL_NAME_CHARACTERS {
        return Err(format!(
            "模型名称不能超过 {MAX_MODEL_NAME_CHARACTERS} 个字符"
        ));
    }
    if value
        .chars()
        .any(|character| character == '\0' || character.is_control())
    {
        return Err("模型名称包含不支持的控制字符".to_string());
    }
    Ok(value.to_string())
}

pub(crate) fn validate_request_id(value: &str) -> Result<String, String> {
    validate_identifier(value, "请求 ID", MAX_REQUEST_ID_CHARACTERS)
}

pub(crate) fn validate_conversation_id(value: &str) -> Result<String, String> {
    validate_identifier(value, "会话 ID", MAX_CONVERSATION_ID_CHARACTERS)
}

fn validate_identifier(value: &str, label: &str, maximum: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if value.chars().count() > maximum {
        return Err(format!("{label}不能超过 {maximum} 个字符"));
    }
    if value
        .chars()
        .any(|character| character == '\0' || character.is_control())
    {
        return Err(format!("{label}包含不支持的控制字符"));
    }
    Ok(value.to_string())
}

fn validate_messages(messages: &[ChatMessage]) -> Result<(), String> {
    if messages.len() > MAX_MESSAGES {
        return Err(format!("消息数量不能超过 {MAX_MESSAGES} 条"));
    }
    let mut total_bytes = 0usize;
    for message in messages {
        if !matches!(message.role.as_str(), "system" | "user" | "assistant") {
            return Err("不支持的消息角色".to_string());
        }
        if message.content.chars().count() > MAX_MESSAGE_CONTENT_CHARACTERS {
            return Err(format!(
                "单条消息正文不能超过 {MAX_MESSAGE_CONTENT_CHARACTERS} 个字符"
            ));
        }
        if message.content.contains('\0') {
            return Err("消息正文包含不支持的空字符".to_string());
        }
        if let Some(thinking) = &message.thinking {
            if thinking.chars().count() > MAX_MESSAGE_THINKING_CHARACTERS {
                return Err(format!(
                    "单条消息思考内容不能超过 {MAX_MESSAGE_THINKING_CHARACTERS} 个字符"
                ));
            }
            if thinking.contains('\0') {
                return Err("消息思考内容包含不支持的空字符".to_string());
            }
            total_bytes = total_bytes.saturating_add(thinking.len());
        }
        total_bytes = total_bytes.saturating_add(message.content.len());
        if total_bytes > MAX_MESSAGE_TOTAL_BYTES {
            return Err(format!(
                "消息总大小不能超过 {} KiB",
                MAX_MESSAGE_TOTAL_BYTES / 1024
            ));
        }
    }
    Ok(())
}

fn estimate_tokens(message: &ChatMessage) -> usize {
    (message.content.chars().count() * 2 / 7).max(1) + 4
}

pub(crate) fn trim_fast_history(messages: &[ChatMessage], max_tokens: usize) -> Vec<ChatMessage> {
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

pub(crate) fn prepare_messages(
    messages: Vec<ChatMessage>,
    mode: &str,
) -> Result<(Vec<ChatMessage>, GenerationProfile), String> {
    validate_messages(&messages)?;
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

pub(crate) fn inject_attachment_context(
    mut messages: Vec<ChatMessage>,
    mode: &str,
    profile: &GenerationProfile,
    attachments: &[attachments::ParsedAttachment],
) -> Result<Vec<ChatMessage>, String> {
    let Some(context) = attachments::build_context(
        attachments,
        messages
            .last()
            .map(|message| message.content.as_str())
            .unwrap_or_default(),
        profile.num_ctx,
    )?
    else {
        return Ok(messages);
    };
    if mode == "fast" {
        // Give attached material priority over older turns while keeping the
        // newest user message, which is the fast-mode contract.
        let context_tokens = estimate_tokens(&ChatMessage {
            role: "system".to_string(),
            content: context.clone(),
            thinking: None,
        });
        let history_budget = profile
            .max_history_tokens
            .saturating_sub(context_tokens.min(profile.max_history_tokens / 2));
        messages = trim_fast_history(&messages, history_budget.max(128));
    }
    let insertion = messages
        .iter()
        .rposition(|message| message.role == "user")
        .unwrap_or(messages.len());
    messages.insert(
        insertion,
        ChatMessage {
            role: "system".to_string(),
            content: context,
            thinking: None,
        },
    );
    Ok(messages)
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

pub(crate) fn cancel_active(
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

#[cfg(test)]
pub(crate) fn queue_stream_chunk(
    request_id: &str,
    chunk: OllamaStreamChunk,
    pending: &mut PendingBatch,
    first_event_sent: bool,
    batching_enabled: bool,
) -> (bool, bool) {
    let event = stream_event_from_chunk(request_id, chunk);
    queue_stream_event(event, pending, first_event_sent, batching_enabled)
}

fn queue_stream_event(
    event: ChatStreamEvent,
    pending: &mut PendingBatch,
    first_event_sent: bool,
    batching_enabled: bool,
) -> (bool, bool) {
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

fn account_stream_event(
    event: &ChatStreamEvent,
    content_bytes: &mut usize,
    thinking_bytes: &mut usize,
) -> Result<(), String> {
    let next_content = content_bytes.saturating_add(event.content.len());
    if next_content > MAX_STREAM_CONTENT_BYTES {
        return Err(format!(
            "Ollama 正文响应超过 {} MiB 限制",
            MAX_STREAM_CONTENT_BYTES / 1024 / 1024
        ));
    }
    let next_thinking = thinking_bytes.saturating_add(event.thinking.len());
    if next_thinking > MAX_STREAM_THINKING_BYTES {
        return Err(format!(
            "Ollama 思考响应超过 {} MiB 限制",
            MAX_STREAM_THINKING_BYTES / 1024 / 1024
        ));
    }
    *content_bytes = next_content;
    *thinking_bytes = next_thinking;
    Ok(())
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

pub(crate) fn parse_stream_line(line: &[u8]) -> Result<Option<OllamaStreamChunk>, String> {
    if line.len() > MAX_STREAM_LINE_BYTES {
        return Err(format!(
            "Ollama 流单行响应超过 {} MiB 限制",
            MAX_STREAM_LINE_BYTES / 1024 / 1024
        ));
    }
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    serde_json::from_slice::<OllamaStreamChunk>(line)
        .map(Some)
        .map_err(|error| format!("无法解析 Ollama 流响应：{error}"))
}

pub(crate) async fn run_chat_stream(
    app: AppHandle,
    active: Arc<Mutex<Option<ActiveChat>>>,
    runtime: Arc<dyn ModelRuntime>,
    request_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    profile: GenerationProfile,
    cancellation: CancellationToken,
) {
    let mut diagnostics = StreamDiagnostics::new(request_id.clone());
    let body = serde_json::to_value(ChatRequest {
        model,
        messages,
        stream: true,
        think: profile.think,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: ChatOptions {
            num_ctx: profile.num_ctx,
            num_predict: profile.num_predict,
            temperature: 0.7,
        },
    });
    let body = body.expect("序列化 Ollama 聊天请求失败");

    emit_diagnostic_phase(&app, &diagnostics, "T2");
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            clear_active(&active, &request_id);
            emit_cancelled(&app, &request_id, &mut diagnostics);
            return;
        }
        result = runtime.chat(body) => result
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
            result = read_response_text_limited(response, MAX_ERROR_RESPONSE_BYTES) => {
                result.unwrap_or_else(|error| error)
            }
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
    let mut content_bytes = 0usize;
    let mut thinking_bytes = 0usize;
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
        let next_total = diagnostics.bytes_received.saturating_add(bytes.len());
        if next_total > MAX_STREAM_TOTAL_BYTES {
            flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
            clear_active(&active, &request_id);
            emit_error(
                &app,
                &request_id,
                format!(
                    "Ollama 流响应超过 {} MiB 限制",
                    MAX_STREAM_TOTAL_BYTES / 1024 / 1024
                ),
                &mut diagnostics,
            );
            return;
        }
        let first_line_size = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |position| position.saturating_add(1));
        if buffer.len().saturating_add(first_line_size) > MAX_STREAM_LINE_BYTES {
            flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
            clear_active(&active, &request_id);
            emit_error(
                &app,
                &request_id,
                format!(
                    "Ollama 流单行响应超过 {} MiB 限制",
                    MAX_STREAM_LINE_BYTES / 1024 / 1024
                ),
                &mut diagnostics,
            );
            return;
        }
        diagnostics.bytes_received = next_total;
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
            let event = stream_event_from_chunk(&request_id, chunk);
            if let Err(error) =
                account_stream_event(&event, &mut content_bytes, &mut thinking_bytes)
            {
                flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                clear_active(&active, &request_id);
                emit_error(&app, &request_id, error, &mut diagnostics);
                return;
            }
            let (done, should_flush) =
                queue_stream_event(event, &mut pending, first_event_sent, batching_enabled);
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
                    let event = stream_event_from_chunk(&request_id, chunk);
                    if let Err(error) =
                        account_stream_event(&event, &mut content_bytes, &mut thinking_bytes)
                    {
                        flush_pending_batch(&app, &request_id, &mut pending, &mut diagnostics);
                        clear_active(&active, &request_id);
                        emit_error(&app, &request_id, error, &mut diagnostics);
                        return;
                    }
                    let (done, should_flush) =
                        queue_stream_event(event, &mut pending, first_event_sent, batching_enabled);
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
