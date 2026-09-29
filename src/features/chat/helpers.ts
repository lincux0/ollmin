import { deriveChatMetrics } from "../../lib/metrics";
import type {
  ChatMessage,
  ChatMetrics,
  ChatResponse,
  StoredMessage,
} from "../../contracts/ipc";
import type { ConversationMessage, MessageStatus } from "./types";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function newId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId
    ? `${prefix}-${randomId}`
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function toChatMessage(message: ConversationMessage): ChatMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.thinking ? { thinking: message.thinking } : {}),
  };
}

export function messageStatus(value: string): MessageStatus {
  return value === "streaming" || value === "cancelled" || value === "error"
    ? value
    : "done";
}

export function safeMode(
  value: string,
): "fast" | "balanced" | "reasoning" {
  return value === "fast" || value === "balanced" || value === "reasoning"
    ? value
    : "fast";
}

export function fromStoredMessage(
  message: StoredMessage,
  alias?: string,
): ConversationMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    thinking: message.thinking ?? undefined,
    status: messageStatus(message.status),
    createdAt: message.createdAt,
    metrics: message.metrics ?? null,
    modelAlias: alias,
    attachments: message.attachments,
  };
}

export function responseMetrics(
  response: ChatResponse | undefined,
  startedAt: number,
): ChatMetrics | null {
  return response
    ? deriveChatMetrics(response, performance.now() - startedAt)
    : null;
}
