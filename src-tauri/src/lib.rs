use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use storage::{AppSettings, ConversationDetail, ConversationSummary, ExportPayload, MessageInput};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

mod attachments;
mod chat;
mod commands;
mod file_security;
mod platform;
mod storage;

pub(crate) use chat::{
    cancel_active, diagnostics_enabled, inject_attachment_context, override_context_size,
    override_output_token_limit, override_reasoning_token_limit, prepare_messages, run_chat_stream,
    validate_conversation_id, validate_model_name, validate_request_id,
};
pub(crate) use platform::contracts::{
    ChatDiagnosticEvent, ChatMessage, ChatStreamEvent, GenerationProfile, OllamaStreamChunk,
};
pub(crate) use platform::runtime::{ModelRuntime, OllamaLocalAdapter};
pub fn run() {
    commands::run();
}

const STREAM_BATCH_WINDOW_MS: u64 = 24;
const STREAM_BATCH_MAX_BYTES: usize = 16 * 1024;
const STREAM_BATCHING_ENV: &str = "OLLMIN_STREAM_BATCHING";
const DEFAULT_CONTEXT_SIZE: u32 = 4096;

struct ActiveChat {
    request_id: String,
    cancellation: CancellationToken,
}

#[derive(Clone)]
struct ChatState {
    active: Arc<Mutex<Option<ActiveChat>>>,
    runtime: Arc<dyn ModelRuntime>,
}

impl Default for ChatState {
    fn default() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
            runtime: Arc::new(OllamaLocalAdapter::default()),
        }
    }
}

struct DatabaseState {
    connection: Mutex<rusqlite::Connection>,
}

#[derive(Default)]
struct AttachmentState {
    parsed: Mutex<HashMap<String, attachments::ParsedAttachment>>,
}

fn remove_cached_ids<T>(cache: &mut HashMap<String, T>, ids: &[String]) -> usize {
    ids.iter().filter(|id| cache.remove(*id).is_some()).count()
}

impl AttachmentState {
    fn release(&self, ids: &[String]) -> Result<(), String> {
        let mut cache = self
            .parsed
            .lock()
            .map_err(|_| "无法获取本地附件缓存锁".to_string())?;
        remove_cached_ids(&mut cache, ids);
        Ok(())
    }
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

#[cfg(test)]
mod tests {
    use super::chat::{parse_stream_line, profile_for_mode, queue_stream_chunk, trim_fast_history};
    use super::{
        cancel_active, override_context_size, override_output_token_limit,
        override_reasoning_token_limit, remove_cached_ids, ActiveChat, ChatMessage,
        OllamaStreamChunk, PendingBatch, STREAM_BATCH_MAX_BYTES,
    };
    use bytes::BytesMut;
    use std::collections::HashMap;
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
        assert!(override_output_token_limit(&mut profile, Some(12345)).is_err());
    }

    #[test]
    fn reasoning_and_message_limits_compose_generation_budget() {
        let mut profile = profile_for_mode("reasoning").expect("reasoning profile");
        override_output_token_limit(&mut profile, Some(4096)).expect("override output limit");
        override_reasoning_token_limit(&mut profile, Some(8192)).expect("override reasoning limit");
        assert_eq!(profile.num_predict, 12288);

        override_reasoning_token_limit(&mut profile, Some(0)).expect("bounded unlimited reasoning");
        assert_eq!(profile.num_predict, 16384);
        assert!(override_reasoning_token_limit(&mut profile, Some(1024)).is_err());
    }

    #[test]
    fn fast_mode_keeps_reasoning_limit_disabled() {
        let mut profile = profile_for_mode("fast").expect("fast profile");
        override_output_token_limit(&mut profile, Some(4096)).expect("override output limit");
        override_reasoning_token_limit(&mut profile, Some(8192)).expect("override reasoning limit");
        assert_eq!(profile.num_predict, 4096);
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
    fn direct_chat_inputs_are_rejected_before_runtime_work() {
        assert!(super::prepare_messages(vec![message("tool", "ignored")], "fast").is_err());
        assert!(
            super::prepare_messages(vec![message("user", &"x".repeat(64 * 1024 + 1))], "fast",)
                .is_err()
        );
        assert!(super::validate_model_name("model\nname").is_err());
        assert!(super::validate_request_id(&"r".repeat(129)).is_err());
    }

    #[test]
    fn oversized_stream_lines_are_rejected_before_json_parsing() {
        let line = vec![b' '; 2 * 1024 * 1024 + 1];
        let error = parse_stream_line(&line).expect_err("oversized stream line");
        assert!(error.contains("超过 2 MiB"));
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

    #[test]
    fn attachment_cache_release_drops_only_requested_ids() {
        let mut cache = HashMap::from([
            ("attachment-a".to_string(), 1_u8),
            ("attachment-b".to_string(), 2_u8),
        ]);
        let released = remove_cached_ids(
            &mut cache,
            &["attachment-a".to_string(), "attachment-missing".to_string()],
        );
        assert_eq!(released, 1);
        assert!(!cache.contains_key("attachment-a"));
        assert_eq!(cache.get("attachment-b"), Some(&2));
    }
}
