import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { AttachmentSummary } from "../../contracts/ipc";
import Icon from "../shell/Icon";
import { attachmentDetail, MAX_COMPOSER_ATTACHMENTS } from "../attachments/helpers";
import { composerMaxHeight, shouldSubmitOnEnter } from "./composerHelpers";

export interface ComposerProps {
  draft: string;
  setDraft: (draft: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  hero: boolean;
  busy: boolean;
  online: boolean;
  hasModel: boolean;
  warming: boolean;
  loadingConversation: boolean;
  parsingAttachments: boolean;
  attachments: AttachmentSummary[];
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
  onAddAttachments: () => Promise<void>;
  onRemoveAttachment: (id: string) => void;
  modelControl: ReactNode;
  fontSize?: number;
}

export default function Composer({
  draft, setDraft, textareaRef, hero, busy, online, hasModel, warming,
  loadingConversation, parsingAttachments, attachments, onSubmit, onStop,
  onAddAttachments, onRemoveAttachment, modelControl, fontSize = 14,
}: ComposerProps) {
  const composing = useRef(false);
  const submitPending = useRef(false);
  const [isComposing, setIsComposing] = useState(false);
  const canSend = online && hasModel && !busy && !warming && !loadingConversation
    && !parsingAttachments && Boolean(draft.trim());
  const inputDisabled = !hasModel || warming || loadingConversation;
  const addDisabled = busy || warming || loadingConversation || parsingAttachments
    || attachments.length >= MAX_COMPOSER_ATTACHMENTS;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const resize = () => {
      const maxHeight = composerMaxHeight(window.innerHeight);
      const minHeight = hero ? 52 : 36;
      textarea.style.height = "auto";
      textarea.style.maxHeight = `${maxHeight}px`;
      const nextHeight = Math.min(maxHeight, Math.max(minHeight, textarea.scrollHeight));
      textarea.style.height = `${nextHeight}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (textarea.parentElement) observer?.observe(textarea.parentElement);
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [draft, hero, textareaRef, fontSize]);

  const submit = async () => {
    if (!canSend || isComposing || composing.current || submitPending.current) return;
    submitPending.current = true;
    try {
      await onSubmit();
    } finally {
      submitPending.current = false;
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitOnEnter(event.nativeEvent, composing.current || isComposing)) return;
    event.preventDefault();
    void submit();
  };

  return (
    <form className={`composer ${hero ? "composer-hero" : "composer-bottom"}`} onSubmit={handleSubmit}>
      {attachments.length > 0 ? <div className="composer-attachments" aria-label="已解析附件">
        {attachments.map((attachment) => (
          <div className="attachment-chip" key={attachment.id} title={attachment.warnings.join("\n") || attachment.name}>
            <div className="attachment-chip-copy">
              <strong>{attachment.kind} · {attachment.name}</strong>
              <small>{attachmentDetail(attachment)} · 已本地解析</small>
              {attachment.warnings.length > 0 ? <small className="attachment-warning">{attachment.warnings.join("；")}</small> : null}
            </div>
            <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => onRemoveAttachment(attachment.id)} disabled={parsingAttachments}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
        <p>发送时会按当前问题选取有限片段作为本地参考资料；完整文件不会上传。</p>
      </div> : null}
      {parsingAttachments ? <div className="composer-attachment-status" role="status">正在本地解析附件…</div> : null}
      <textarea
        ref={textareaRef}
        className="composer-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => { composing.current = true; setIsComposing(true); }}
        onCompositionEnd={() => { composing.current = false; setIsComposing(false); }}
        onKeyDown={handleKeyDown}
        placeholder={hasModel ? "输入消息，Enter 发送，Shift+Enter 换行" : "先选择一个本地模型"}
        disabled={inputDisabled}
        rows={1}
        aria-label="输入消息"
      />
      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          <button type="button" className="composer-file-button" onClick={() => void onAddAttachments()} disabled={addDisabled} title={attachments.length >= MAX_COMPOSER_ATTACHMENTS ? `最多保留 ${MAX_COMPOSER_ATTACHMENTS} 个附件` : undefined}>
            {parsingAttachments ? "解析中…" : <><Icon name="plus" size={14} />附件</>}
          </button>
        </div>
        <div className="composer-toolbar-right">
          {modelControl}
          {busy
            ? <button type="button" className="composer-main-action" aria-label="停止生成" onClick={(event) => { event.preventDefault(); void onStop(); }}><span>停止</span></button>
            : <button type="submit" className="composer-main-action" aria-label="发送" disabled={!canSend}><Icon name="send" size={18} /><span>发送</span></button>}
        </div>
      </div>
    </form>
  );
}
