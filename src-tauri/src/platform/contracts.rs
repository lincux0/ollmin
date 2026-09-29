use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct ChatMessage {
    pub(crate) role: String,
    pub(crate) content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) thinking: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct GenerationProfile {
    pub(crate) think: bool,
    pub(crate) num_ctx: u32,
    pub(crate) num_predict: i32,
    pub(crate) max_history_tokens: usize,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatOptions {
    pub(crate) num_ctx: u32,
    pub(crate) num_predict: i32,
    pub(crate) temperature: f64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatRequest {
    pub(crate) model: String,
    pub(crate) messages: Vec<ChatMessage>,
    pub(crate) stream: bool,
    pub(crate) think: bool,
    pub(crate) keep_alive: &'static str,
    pub(crate) options: ChatOptions,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub(crate) struct OllamaStreamChunk {
    pub(crate) model: Option<String>,
    pub(crate) created_at: Option<String>,
    pub(crate) message: Option<ChatMessage>,
    pub(crate) done: Option<bool>,
    pub(crate) done_reason: Option<String>,
    pub(crate) total_duration: Option<u64>,
    pub(crate) load_duration: Option<u64>,
    pub(crate) prompt_eval_count: Option<u64>,
    pub(crate) prompt_eval_duration: Option<u64>,
    pub(crate) eval_count: Option<u64>,
    pub(crate) eval_duration: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatStreamEvent {
    pub(crate) request_id: String,
    pub(crate) content: String,
    pub(crate) thinking: String,
    pub(crate) done: bool,
    pub(crate) cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) response: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatDiagnosticEvent {
    pub(crate) request_id: String,
    pub(crate) phase: String,
    pub(crate) elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) first_byte_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) first_line_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) first_emit_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) final_emit_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bytes_received: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parsed_events: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) emitted_events: Option<u64>,
}
