import type {
  AttachmentSummary,
  ChatMessage,
  ChatMetrics,
  ConversationSummary,
} from "../../contracts/ipc";

export type MessageStatus = "streaming" | "done" | "cancelled" | "error";

export interface ConversationMessage extends ChatMessage {
  id: string;
  status: MessageStatus;
  error?: string;
  createdAt?: string;
  metrics?: ChatMetrics | null;
  modelAlias?: string;
  attachments?: AttachmentSummary[];
}

export interface AssistantBuffer {
  requestId: string;
  conversationId: string;
  id: string;
  content: string;
  thinking: string;
  metrics: ChatMetrics | null;
}

export interface AssistantSnapshot {
  requestId: string;
  id: string;
  content: string;
  thinking: string;
  metrics: ChatMetrics | null;
  status: MessageStatus;
  error?: string;
  terminal: boolean;
}

export interface SessionContextMenu {
  conversation: ConversationSummary;
  x: number;
  y: number;
}
