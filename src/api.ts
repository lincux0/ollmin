import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ChatResponse,
  ChatStreamPayload,
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  ExportPayload,
  LoadedModelResponse,
  ModelListResponse,
  PersistedMessageInput,
  ServiceStatus,
} from "./types";
import { DEFAULT_CONTEXT_SIZE, type ContextSize, type PerformanceMode } from "./lib/performance";

export function getServiceStatus(): Promise<ServiceStatus> {
  return invoke<ServiceStatus>("get_service_status");
}

export function getModels(): Promise<ModelListResponse> {
  return invoke<ModelListResponse>("get_models");
}

export function getLoadedModels(): Promise<LoadedModelResponse> {
  return invoke<LoadedModelResponse>("get_loaded_models");
}

export function warmModel(model: string): Promise<ChatResponse> {
  return invoke<ChatResponse>("warm_model", { model });
}

export function diagnoseChat(
  model: string,
  messages: ChatMessage[],
  mode: PerformanceMode,
  contextSize: ContextSize = DEFAULT_CONTEXT_SIZE,
): Promise<ChatResponse> {
  return invoke<ChatResponse>("diagnose_chat", { model, messages, mode, contextSize });
}

export function startChat(
  model: string,
  messages: ChatMessage[],
  mode: PerformanceMode,
  requestId: string,
  contextSize: ContextSize = DEFAULT_CONTEXT_SIZE,
): Promise<void> {
  return invoke<void>("start_chat", { model, messages, mode, requestId, contextSize });
}

export function stopChat(requestId: string): Promise<boolean> {
  return invoke<boolean>("stop_chat", { requestId });
}

export function listConversations(query?: string): Promise<ConversationSummary[]> {
  return invoke<ConversationSummary[]>("list_conversations", { query });
}

export function createConversation(
  id: string,
  model: string,
  mode: PerformanceMode,
  title?: string,
  modelAlias?: string,
): Promise<ConversationDetail> {
  return invoke<ConversationDetail>("create_conversation", { id, model, mode, title, modelAlias });
}

export function createConversationWithMessage(
  id: string,
  model: string,
  mode: PerformanceMode,
  message: PersistedMessageInput,
  title?: string,
  modelAlias?: string,
): Promise<ConversationDetail> {
  return invoke<ConversationDetail>("create_conversation_with_message", {
    id,
    model,
    mode,
    title,
    modelAlias,
    message,
  });
}

export function getConversation(conversationId: string): Promise<ConversationDetail> {
  return invoke<ConversationDetail>("get_conversation", { conversationId });
}

export function renameConversation(conversationId: string, title: string): Promise<ConversationSummary> {
  return invoke<ConversationSummary>("rename_conversation", { conversationId, title });
}

export function deleteConversation(conversationId: string): Promise<void> {
  return invoke<void>("delete_conversation", { conversationId });
}

export function saveMessage(message: PersistedMessageInput): Promise<void> {
  return invoke<void>("save_message", { message });
}

export function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

export function updateSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>("update_settings", { settings });
}

export function clearConversations(): Promise<void> {
  return invoke<void>("clear_conversations");
}

export function exportConversation(conversationId: string, format: ExportPayload["format"]): Promise<ExportPayload> {
  return invoke<ExportPayload>("export_conversation", { conversationId, format });
}

export type ChatStreamEvent = ChatStreamPayload;
