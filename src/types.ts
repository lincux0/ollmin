export type JsonRecord = Record<string, unknown>;

export interface OllamaModel {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: JsonRecord;
}

export interface ModelListResponse {
  models?: OllamaModel[];
}

export interface LoadedModel {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
  details?: JsonRecord;
}

export interface LoadedModelResponse {
  models?: LoadedModel[];
}

export interface ServiceStatus {
  version?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  thinking?: string;
}

export interface ChatResponse {
  model?: string;
  message?: ChatMessage;
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface ChatStreamPayload {
  request_id: string;
  content: string;
  thinking: string;
  done: boolean;
  cancelled: boolean;
  sequence?: number;
  error?: string;
  response?: ChatResponse;
}

export interface ChatDiagnosticPayload {
  request_id: string;
  phase: string;
  elapsed_ms: number;
  first_byte_ms?: number;
  first_line_ms?: number;
  first_emit_ms?: number;
  final_emit_ms?: number;
  bytes_received?: number;
  parsed_events?: number;
  emitted_events?: number;
}

export type ThemeMode = "system" | "light" | "dark";

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  modelAlias: string;
  mode: import("./lib/performance").PerformanceMode;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: ChatMessage["role"];
  content: string;
  thinking?: string | null;
  status: "streaming" | "done" | "cancelled" | "error";
  createdAt: string;
  metrics?: ChatMetrics | null;
}

export interface PersistedMessageInput {
  id: string;
  conversationId: string;
  role: ChatMessage["role"];
  content: string;
  thinking?: string | null;
  status: StoredMessage["status"];
  createdAt?: string;
  metrics?: ChatMetrics | null;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: StoredMessage[];
}

export interface AppSettings {
  theme: ThemeMode;
  saveThinking: boolean;
  defaultMode: import("./lib/performance").PerformanceMode;
  defaultModel: string;
  modelAliases: Record<string, string>;
  contextSize: import("./lib/performance").ContextSize;
  outputTokenLimit: import("./lib/performance").OutputTokenLimit;
  reasoningTokenLimit: import("./lib/performance").ReasoningTokenLimit;
}

export interface ExportPayload {
  filename: string;
  format: "markdown" | "json";
  content: string;
}

export interface ChatMetrics {
  wallMs: number;
  totalMs: number | null;
  loadMs: number | null;
  promptMs: number | null;
  evalMs: number | null;
  promptTokens: number | null;
  outputTokens: number | null;
  outputTokensPerSecond: number | null;
  thinkingCharacters: number;
  /** Ollama's terminal reason, e.g. "stop" or "length". */
  stopReason?: string | null;
}

export interface DiagnosticResult {
  response: ChatResponse;
  metrics: ChatMetrics;
  startedAt: string;
  model: string;
  mode: import("./lib/performance").PerformanceMode;
  think: boolean;
  promptLabel: string;
  historyMessages: number;
  estimatedHistoryTokens: number;
}
