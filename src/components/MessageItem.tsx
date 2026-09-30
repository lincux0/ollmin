import { memo, useEffect, useState } from "react";
import type { AttachmentSummary, ChatMessage } from "../contracts/ipc";
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

export type MessageCopy = Pick<MessageItemData, "id" | "content">;

export interface MessageItemProps {
  message: MessageItemData;
  copied: boolean;
  copiedThinking?: boolean;
  onCopy: (message: MessageCopy) => void | Promise<void>;
}

/**
 * App keeps unchanged message objects stable while streaming. Ignore the
 * callback identity so a parent render does not invalidate every history row.
 */
export function areMessageItemPropsEqual(previous: MessageItemProps, next: MessageItemProps): boolean {
  return previous.message === next.message && previous.copied === next.copied &&
    previous.copiedThinking === next.copiedThinking;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MessageItem({ message, copied, copiedThinking, onCopy }: MessageItemProps) {
  const [thinkingOpen, setThinkingOpen] = useState(message.status === "streaming");
  const [copiedPart, setCopiedPart] = useState<string | null>(null);
  const [copyError, setCopyError] = useState("");

  useEffect(() => {
    if (!copiedPart) return;
    const timer = window.setTimeout(() => setCopiedPart(null), 1400);
    return () => window.clearTimeout(timer);
  }, [copiedPart]);

  async function copy(part: string, content: string) {
    try {
      await onCopy({ id: part ? `${message.id}:${part}` : message.id, content });
      setCopiedPart(part || "body");
      setCopyError("");
    } catch (error) {
      setCopiedPart(null);
      setCopyError(errorText(error));
    }
  }

  return (
    <article className={`message ${message.role} ${message.status}`} data-message-id={message.id} data-role={message.role}>
      {message.role === "assistant" || message.status !== "done" ? (
        <div className="message-meta">
          {message.role === "assistant" ? <span>{message.modelAlias || "模型"}</span> : null}
          {message.status === "streaming" ? <span className="streaming-label">生成中…</span> : null}
          {message.status === "cancelled" ? <span>已停止</span> : null}
          {message.status === "error" ? <span>失败</span> : null}
          {message.role === "assistant" && message.content ? (
            <button
              type="button"
              className="copy-button"
              aria-label={copied || copiedPart === "body" ? "已复制回复" : "复制回复"}
              title={copied || copiedPart === "body" ? "已复制回复" : "复制回复"}
              onClick={() => void copy("", message.content)}
            >
              <CopyIcon copied={copied || copiedPart === "body"} />
            </button>
          ) : null}
        </div>
      ) : null}
      {message.role === "user" && message.content ? (
        <button
          type="button"
          className="message-copy-button"
          aria-label={copied || copiedPart === "body" ? "已复制问题" : "复制问题"}
          onClick={() => void copy("", message.content)}
        >
          <CopyIcon copied={copied || copiedPart === "body"} />
        </button>
      ) : null}
      {message.role === "assistant" && message.thinking ? (
        <details className="thinking-block" open={thinkingOpen} onToggle={(event) => setThinkingOpen(event.currentTarget.open)}>
          <summary>
            <span>思考过程</span>
          </summary>
          <button
            type="button"
            className="thinking-copy-button"
            aria-label={copiedThinking || copiedPart === "thinking" ? "已复制思考过程" : "复制思考过程"}
            onClick={() => void copy("thinking", message.thinking ?? "")}
          >
            <CopyIcon copied={copiedThinking || copiedPart === "thinking"} />
          </button>
          <p>{message.thinking}</p>
        </details>
      ) : null}
      <div className="message-content">
        {message.role === "assistant" ? (
          <MarkdownContent
            content={message.content}
            onCopy={(suffix, content) => copy(suffix, content)}
            copiedId={copiedPart}
          />
        ) : <p>{message.content}</p>}
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
      {copyError ? <p className="message-copy-error" role="alert">复制失败：{copyError}</p> : null}
      {message.error ? <p className="message-error">{message.error}</p> : null}
    </article>
  );
}

function CopyIcon({ copied }: { copied: boolean }) {
  return (
    <svg aria-hidden="true" focusable="false" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {copied ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>}
    </svg>
  );
}

export default memo(MessageItem, areMessageItemPropsEqual);
