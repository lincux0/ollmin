import { memo } from "react";
import type { AttachmentSummary, ChatMessage } from "../types";
import MarkdownContent from "./MarkdownContent";

export type MessageItemStatus = "streaming" | "done" | "cancelled" | "error";

export interface MessageItemData {
  id: string;
  role: ChatMessage["role"];
  content: string;
  thinking?: string;
  status: MessageItemStatus;
  error?: string;
  modelAlias?: string;
  attachments?: AttachmentSummary[];
}

export interface MessageItemProps {
  message: MessageItemData;
  copied: boolean;
  onCopy: (message: Pick<MessageItemData, "id" | "content">) => void;
}

export interface ThinkingBlockProps {
  thinking: string;
  open: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ thinking, open }: ThinkingBlockProps) {
  return (
    <details className="thinking-block" open={open}>
      <summary>思考过程</summary>
      <p>{thinking}</p>
    </details>
  );
});

/**
 * App keeps unchanged message objects stable while streaming. Ignore the
 * callback identity so a parent render does not invalidate every history row.
 */
export function areMessageItemPropsEqual(previous: MessageItemProps, next: MessageItemProps): boolean {
  return previous.message === next.message && previous.copied === next.copied;
}

function attachmentDetail(attachment: AttachmentSummary): string {
  if (attachment.kind === "Excel") {
    const rows = attachment.sheets.reduce((total, sheet) => total + sheet.rows, 0);
    return `${attachment.sheets.length} 个工作表 · ${rows} 行`;
  }
  return attachment.kind === "PDF"
    ? `${attachment.pageCount ?? 0} 页 · ${attachment.chunkCount} 个片段`
    : `${attachment.chunkCount} 个片段`;
}

function MessageItem({ message, copied, onCopy }: MessageItemProps) {
  return (
    <article className={`message ${message.role} ${message.status}`}>
      <div className="message-meta">
        <span>{message.role === "user" ? "你" : message.modelAlias || "模型"}</span>
        {message.status === "streaming" ? <span className="streaming-label">生成中…</span> : null}
        {message.status === "cancelled" ? <span>已停止</span> : null}
        {message.status === "error" ? <span>失败</span> : null}
      </div>
      {message.role === "assistant" && message.thinking ? (
        <ThinkingBlock thinking={message.thinking} open={message.status === "streaming"} />
      ) : null}
      <div className="message-content">
        {message.role === "assistant" ? <MarkdownContent content={message.content} /> : <p>{message.content}</p>}
        {message.status === "streaming" ? <span className="cursor" /> : null}
      </div>
      {message.role === "user" && message.attachments && message.attachments.length > 0 ? (
        <div className="message-attachments" aria-label="随消息发送的附件">
          {message.attachments.map((attachment) => (
            <div className="message-attachment" key={attachment.id} title={attachment.warnings.join("\n") || attachment.name}>
              <strong>{attachment.kind} · {attachment.name}</strong>
              <small>{attachmentDetail(attachment)} · 已作为本地参考资料发送</small>
            </div>
          ))}
        </div>
      ) : null}
      {message.error ? <p className="message-error">{message.error}</p> : null}
      {message.role === "assistant" && message.content ? (
        <button className="copy-button" onClick={() => void onCopy(message)}>
          {copied ? "已复制" : "复制"}
        </button>
      ) : null}
    </article>
  );
}

export default memo(MessageItem, areMessageItemPropsEqual);
