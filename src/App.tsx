import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./index.css";
import {
  clearConversations,
  createConversation,
  deleteConversation,
  exportConversation,
  getConversation,
  getModels,
  getServiceStatus,
  getSettings,
  listConversations,
  renameConversation,
  saveMessage,
  startChat,
  stopChat,
  updateSettings,
  warmModel,
} from "./api";
import MarkdownContent from "./components/MarkdownContent";
import { trimHistoryForFastMode } from "./lib/history";
import { deriveChatMetrics, formatMetric } from "./lib/metrics";
import { PERFORMANCE_PROFILES, profileForMode, type PerformanceMode } from "./lib/performance";
import type {
  AppSettings,
  ChatMessage,
  ChatMetrics,
  ChatResponse,
  ChatStreamPayload,
  ConversationDetail,
  ConversationSummary,
  ExportPayload,
  OllamaModel,
  PersistedMessageInput,
  ServiceStatus,
  StoredMessage,
  ThemeMode,
} from "./types";

type MessageStatus = "streaming" | "done" | "cancelled" | "error";

interface ConversationMessage extends ChatMessage {
  id: string;
  status: MessageStatus;
  error?: string;
  createdAt?: string;
  metrics?: ChatMetrics | null;
}

interface AssistantBuffer {
  requestId: string;
  conversationId: string;
  id: string;
  content: string;
  thinking: string;
  metrics: ChatMetrics | null;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  saveThinking: false,
  defaultMode: "fast",
};

function modelName(model: OllamaModel): string {
  return model.name ?? model.model ?? "未知模型";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? `${prefix}-${randomId}` : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toChatMessage(message: ConversationMessage): ChatMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.thinking ? { thinking: message.thinking } : {}),
  };
}

function messageStatus(value: string): MessageStatus {
  return value === "streaming" || value === "cancelled" || value === "error" ? value : "done";
}

function safeMode(value: string): PerformanceMode {
  return value === "fast" || value === "balanced" || value === "reasoning" ? value : "fast";
}

function fromStoredMessage(message: StoredMessage): ConversationMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    thinking: message.thinking ?? undefined,
    status: messageStatus(message.status),
    createdAt: message.createdAt,
    metrics: message.metrics ?? null,
  };
}

function responseMetrics(response: ChatResponse | undefined, startedAt: number): ChatMetrics | null {
  return response ? deriveChatMetrics(response, performance.now() - startedAt) : null;
}

function displayTime(value: string): string {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function downloadExport(payload: ExportPayload) {
  const blob = new Blob([payload.content], { type: payload.format === "json" ? "application/json" : "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = payload.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [mode, setMode] = useState<PerformanceMode>(DEFAULT_SETTINGS.defaultMode);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [warming, setWarming] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastMetrics, setLastMetrics] = useState<ChatMetrics | null>(null);
  const [lastElapsedMs, setLastElapsedMs] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [search, setSearch] = useState("");
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const activeRequestId = useRef<string | null>(null);
  const requestConversationId = useRef<string | null>(null);
  const assistantBuffer = useRef<AssistantBuffer | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const requestStartedAt = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshConnection = useCallback(async () => {
    try {
      const [service, modelResponse] = await Promise.all([
        getServiceStatus(),
        getModels(),
      ]);
      const nextModels = modelResponse.models ?? [];
      setStatus(service);
      setModels(nextModels);
      setSelectedModel((current) =>
        current && nextModels.some((model) => modelName(model) === current)
          ? current
          : nextModels.length > 0 ? modelName(nextModels[0]) : "",
      );
    } catch (refreshError) {
      setStatus(null);
      setError(errorText(refreshError));
    }
  }, []);

  const loadConversations = useCallback(async (query = "") => {
    try {
      setConversations(await listConversations(query));
    } catch (conversationError) {
      setError(errorText(conversationError));
    }
  }, []);

  useEffect(() => {
    void refreshConnection();
    void getSettings().then((loadedSettings) => {
      setSettings(loadedSettings);
      setSettingsDraft(loadedSettings);
      setMode(loadedSettings.defaultMode);
    }).catch((settingsError) => setError(errorText(settingsError)));
  }, [refreshConnection]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadConversations(search), 150);
    return () => window.clearTimeout(timer);
  }, [loadConversations, search]);

  useEffect(() => {
    const resolvedTheme: Exclude<ThemeMode, "system"> = settings.theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : settings.theme;
    document.documentElement.dataset.theme = resolvedTheme;
  }, [settings.theme]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ChatStreamPayload>("chat:chunk", ({ payload }) => {
      if (payload.request_id !== activeRequestId.current) return;
      const currentAssistantId = assistantBuffer.current?.id;
      const buffer = assistantBuffer.current;
      if (!currentAssistantId || !buffer) return;

      buffer.content += payload.content || "";
      buffer.thinking += payload.thinking || "";
      if (payload.response) buffer.metrics = responseMetrics(payload.response, requestStartedAt.current);
      const nextStatus: MessageStatus = payload.error
        ? "error"
        : payload.cancelled
          ? "cancelled"
          : payload.done
            ? "done"
            : "streaming";
      setMessages((current) => current.map((message) => message.id === currentAssistantId
        ? {
            ...message,
            content: buffer.content,
            thinking: buffer.thinking || undefined,
            metrics: buffer.metrics,
            status: nextStatus,
            error: payload.error,
          }
        : message));

      if (payload.error) setError(payload.error);
      if (payload.response) {
        setLastMetrics(buffer.metrics);
        setLastElapsedMs(performance.now() - requestStartedAt.current);
      }
      if (payload.done || payload.error || payload.cancelled) {
        const terminalBuffer = { ...buffer };
        if (terminalBuffer.content || nextStatus === "done" || nextStatus === "cancelled") {
          const persisted: PersistedMessageInput = {
            id: terminalBuffer.id,
            conversationId: terminalBuffer.conversationId,
            role: "assistant",
            content: terminalBuffer.content,
            thinking: terminalBuffer.thinking || null,
            status: nextStatus,
            metrics: terminalBuffer.metrics,
          };
          void saveMessage(persisted)
            .then(() => loadConversations(search))
            .catch((persistError) => setError(`保存回复失败：${errorText(persistError)}`));
        }
        activeRequestId.current = null;
        requestConversationId.current = null;
        assistantBuffer.current = null;
        setBusy(false);
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadConversations, search]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (!busy) startNewConversation();
      } else if (event.key === "Escape" && busy) {
        event.preventDefault();
        void cancelMessage();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [busy]);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === currentConversationId),
    [conversations, currentConversationId],
  );
  const profile = profileForMode(mode);

  async function selectConversation(conversation: ConversationSummary) {
    if (busy || loadingConversation || conversation.id === currentConversationId) return;
    setLoadingConversation(true);
    setError(null);
    try {
      const detail: ConversationDetail = await getConversation(conversation.id);
      conversationIdRef.current = detail.conversation.id;
      setCurrentConversationId(detail.conversation.id);
      setSelectedModel(detail.conversation.model);
      setMode(safeMode(detail.conversation.mode));
      const restored = detail.messages.map(fromStoredMessage);
      setMessages(restored);
      const lastWithMetrics = [...detail.messages].reverse().find((message) => message.metrics);
      setLastMetrics(lastWithMetrics?.metrics ?? null);
      setLastElapsedMs(lastWithMetrics?.metrics?.wallMs ?? null);
      setDraft("");
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoadingConversation(false);
      window.setTimeout(() => composerRef.current?.focus(), 0);
    }
  }

  function startNewConversation() {
    if (busy) return;
    conversationIdRef.current = null;
    setCurrentConversationId(null);
    setMessages([]);
    setLastMetrics(null);
    setLastElapsedMs(null);
    setDraft("");
    setError(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!selectedModel || !text || busy || warming || loadingConversation) return;

    const history: ChatMessage[] = [
      ...messages.filter((message) => message.role === "user" || message.role === "assistant").map(toChatMessage),
      { role: "user", content: text },
    ];
    const prepared = mode === "fast"
      ? trimHistoryForFastMode(history, profile.maxHistoryTokens).messages
      : history;
    const requestId = newId("chat");
    const conversationId = conversationIdRef.current ?? newId("conversation");
    const hadConversation = Boolean(conversationIdRef.current);
    const user: ConversationMessage = { id: newId("user"), role: "user", content: text, status: "done", createdAt: new Date().toISOString() };
    const assistant: ConversationMessage = { id: newId("assistant"), role: "assistant", content: "", status: "streaming" };

    setMessages((current) => [...current, user, assistant]);
    setDraft("");
    setError(null);
    setLastMetrics(null);
    setLastElapsedMs(null);
    setBusy(true);
    activeRequestId.current = requestId;
    requestConversationId.current = conversationId;
    assistantBuffer.current = { requestId, conversationId, id: assistant.id, content: "", thinking: "", metrics: null };

    try {
      if (!conversationIdRef.current) {
        conversationIdRef.current = conversationId;
        setCurrentConversationId(conversationId);
        await createConversation(conversationId, selectedModel, mode);
      }
      await saveMessage({
        id: user.id,
        conversationId,
        role: "user",
        content: user.content,
        thinking: null,
        status: "done",
        createdAt: user.createdAt,
      });
      requestStartedAt.current = performance.now();
      await startChat(selectedModel, prepared, mode, requestId);
      await loadConversations(search);
    } catch (startError) {
      const message = errorText(startError);
      setMessages((current) => current.map((item) => item.id === assistant.id ? { ...item, status: "error", error: message } : item));
      setError(message);
      if (!hadConversation && !messages.some((item) => item.role === "user" || item.role === "assistant")) {
        conversationIdRef.current = null;
        setCurrentConversationId(null);
      }
      activeRequestId.current = null;
      requestConversationId.current = null;
      assistantBuffer.current = null;
      setBusy(false);
    }
  }

  async function cancelMessage() {
    const requestId = activeRequestId.current;
    if (!requestId) return;
    try {
      const stopped = await stopChat(requestId);
      if (!stopped) setError("当前请求已经结束或不存在。");
    } catch (stopError) {
      setError(errorText(stopError));
    }
  }

  async function copyMessage(message: ConversationMessage) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((current) => current === message.id ? null : current), 1400);
    } catch (copyError) {
      setError(`复制失败：${errorText(copyError)}`);
    }
  }

  async function runWarmup() {
    if (!selectedModel || warming || busy) return;
    setWarming(true);
    setError(null);
    try {
      await warmModel(selectedModel);
      await refreshConnection();
    } catch (warmupError) {
      setError(errorText(warmupError));
    } finally {
      setWarming(false);
    }
  }

  async function renameCurrentConversation() {
    const conversation = selectedConversation;
    if (!conversation || busy) return;
    const title = window.prompt("会话名称", conversation.title);
    if (title === null || !title.trim()) return;
    try {
      await renameConversation(conversation.id, title.trim());
      await loadConversations(search);
    } catch (renameError) {
      setError(errorText(renameError));
    }
  }

  async function removeConversation(conversation: ConversationSummary) {
    if (busy) return;
    if (!window.confirm(`确定删除“${conversation.title}”及其中的消息吗？`)) return;
    try {
      await deleteConversation(conversation.id);
      if (conversation.id === conversationIdRef.current) startNewConversation();
      await loadConversations(search);
    } catch (deleteError) {
      setError(errorText(deleteError));
    }
  }

  async function exportCurrent(format: ExportPayload["format"]) {
    const id = conversationIdRef.current;
    if (!id) return;
    try {
      downloadExport(await exportConversation(id, format));
    } catch (exportError) {
      setError(errorText(exportError));
    }
  }

  async function clearLocalConversations() {
    if (!window.confirm("确定清空所有本地会话和消息吗？设置不会被删除。")) return;
    try {
      await clearConversations();
      startNewConversation();
      await loadConversations(search);
    } catch (clearError) {
      setError(errorText(clearError));
    }
  }

  async function saveSettingsDraft() {
    setSavingSettings(true);
    try {
      const saved = await updateSettings(settingsDraft);
      setSettings(saved);
      setSettingsDraft(saved);
      if (!busy) setMode(saved.defaultMode);
      setShowSettings(false);
    } catch (settingsError) {
      setError(errorText(settingsError));
    } finally {
      setSavingSettings(false);
    }
  }

  const submitDisabled = !selectedModel || !draft.trim() || busy || warming || loadingConversation;

  return (
    <main className="chat-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">O</div>
          <div>
            <p className="eyebrow">本地优先 · 阶段 3</p>
            <h1>Ollmin</h1>
          </div>
        </div>

        <button className="primary-button new-chat-button" onClick={startNewConversation} disabled={busy}>＋ 新建对话 <span>Ctrl+N</span></button>
        <div className={`status-pill ${status ? "online" : "offline"}`}>
          <span className="status-dot" />
          {status ? `Ollama ${status.version ?? "已连接"}` : "Ollama 未连接"}
        </div>

        <div className="session-tools">
          <label htmlFor="conversation-search">本地会话</label>
          <input id="conversation-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、模型或消息" />
        </div>
        <div className="session-list">
          {conversations.length === 0 ? <p className="session-empty">还没有保存的会话</p> : conversations.map((conversation) => (
            <div className={`session-item ${conversation.id === currentConversationId ? "selected" : ""}`} key={conversation.id}>
              <button className="session-main" onClick={() => void selectConversation(conversation)} disabled={busy || loadingConversation}>
                <strong>{conversation.title}</strong>
                <small>{conversation.model} · {conversation.messageCount} 条 · {displayTime(conversation.updatedAt)}</small>
              </button>
              <div className="session-actions">
                <button title="删除会话" onClick={() => void removeConversation(conversation)} disabled={busy}>×</button>
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-section model-section">
          <label htmlFor="model">模型 {messages.length > 0 ? "（新建对话后可切换）" : ""}</label>
          <select id="model" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={busy || warming || models.length === 0 || messages.length > 0}>
            {models.length === 0 ? <option value="">没有检测到模型</option> : null}
            {models.map((model) => {
              const name = modelName(model);
              return <option key={name} value={name}>{name}</option>;
            })}
          </select>
          <div className="model-mode-row">
            <button className="secondary-button warm-button" onClick={() => void runWarmup()} disabled={!selectedModel || warming || busy}>
              {warming ? "预热中…" : "常驻"}
            </button>
            <div className="mode-control">
              <label htmlFor="mode">性能模式</label>
              <select id="mode" value={mode} onChange={(event) => setMode(event.target.value as PerformanceMode)} disabled={busy}>
                {Object.values(PERFORMANCE_PROFILES).map((item) => <option key={item.mode} value={item.mode}>{item.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="sidebar-bottom">
          <button className="ghost-button" onClick={() => void refreshConnection()} disabled={busy || warming}>刷新连接</button>
          <button className="ghost-button" onClick={() => { setSettingsDraft(settings); setShowSettings(true); }} disabled={busy}>设置</button>
        </div>
      </aside>

      <section className="conversation-panel">
        <header className="conversation-header">
          <div>
            <p className="section-kicker">{selectedConversation?.title ?? "新对话"}</p>
            <h2>{selectedModel || "选择一个本地模型"}</h2>
          </div>
          <div className="conversation-header-actions">
            {currentConversationId ? <>
              <button className="header-button" onClick={renameCurrentConversation} disabled={busy}>重命名</button>
            </> : null}
            {lastMetrics ? <div className="compact-metrics"><span>{formatMetric(lastMetrics.outputTokensPerSecond, 1)} tok/s</span><span>{formatMetric(lastElapsedMs, 0)} ms</span></div> : null}
          </div>
        </header>

        {error ? <div className="error-box"><strong>请求提示</strong><span>{error}</span><small>本地数据保存在应用数据目录；Ollama 仅连接 127.0.0.1:11434。</small></div> : null}

        <div className="message-list" aria-live="polite">
          {loadingConversation ? <div className="empty-state"><div className="empty-icon">…</div><h3>正在恢复会话</h3></div> : messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">⌁</div>
              <h3>开始一段本地对话</h3>
              <p>会话会保存在本机 SQLite。快速模式默认关闭思考并严格裁剪历史；思考内容默认不落盘。</p>
            </div>
          ) : messages.map((message) => (
            <article className={`message ${message.role} ${message.status}`} key={message.id}>
              <div className="message-meta">
                <span>{message.role === "user" ? "你" : "模型"}</span>
                {message.status === "streaming" ? <span className="streaming-label">生成中…</span> : null}
                {message.status === "cancelled" ? <span>已停止</span> : null}
                {message.status === "error" ? <span>失败</span> : null}
              </div>
              {message.role === "assistant" && message.thinking ? <details className="thinking-block" open={message.status === "streaming"}><summary>思考过程</summary><p>{message.thinking}</p></details> : null}
              <div className="message-content">
                {message.role === "assistant" ? <MarkdownContent content={message.content} /> : <p>{message.content}</p>}
                {message.status === "streaming" ? <span className="cursor" /> : null}
              </div>
              {message.error ? <p className="message-error">{message.error}</p> : null}
              {message.role === "assistant" && message.content ? <button className="copy-button" onClick={() => void copyMessage(message)}>{copiedId === message.id ? "已复制" : "复制"}</button> : null}
            </article>
          ))}
        </div>

        {lastMetrics ? <div className="metrics-strip"><span>加载 {formatMetric(lastMetrics.loadMs, 0)} ms</span><span>提示词 {lastMetrics.promptTokens ?? "—"} token · {formatMetric(lastMetrics.promptMs, 0)} ms</span><span>输出 {lastMetrics.outputTokens ?? "—"} token · 思考字符 {lastMetrics.thinkingCharacters}</span></div> : null}

        <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={selectedModel ? "输入消息，Enter 发送，Shift+Enter 换行" : "先在左侧选择一个模型"} disabled={!selectedModel || warming || loadingConversation} rows={3} />
          <div className="composer-actions"><span>{busy ? "正在接收本地流… · Esc 停止" : ""}</span>{busy ? <button type="button" className="stop-button" onClick={() => void cancelMessage()}>停止</button> : null}<button type="submit" className="primary-button" disabled={submitDisabled}>{busy ? "生成中…" : "发送"}</button></div>
        </form>
      </section>

      {showSettings ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSettings(false)}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="section-kicker">本地设置</p><h2 id="settings-title">Ollmin 设置</h2></div><button className="modal-close" onClick={() => setShowSettings(false)}>×</button></div>
          <label htmlFor="theme">主题</label>
          <select id="theme" value={settingsDraft.theme} onChange={(event) => setSettingsDraft((current) => ({ ...current, theme: event.target.value as ThemeMode }))}>
            <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
          </select>
          <label htmlFor="default-mode">默认性能模式</label>
          <select id="default-mode" value={settingsDraft.defaultMode} onChange={(event) => setSettingsDraft((current) => ({ ...current, defaultMode: event.target.value as PerformanceMode }))}>
            {Object.values(PERFORMANCE_PROFILES).map((item) => <option key={item.mode} value={item.mode}>{item.label}</option>)}
          </select>
          <label className="check-row"><input type="checkbox" checked={settingsDraft.saveThinking} onChange={(event) => setSettingsDraft((current) => ({ ...current, saveThinking: event.target.checked }))} />允许把思考内容保存到本地会话</label>
          <p className="settings-note">默认关闭。关闭后，新保存的消息只保留正文；已经保存的思考内容不会自动删除。</p>
          <div className="settings-export">
            <p className="settings-section-label">导出当前会话</p>
            <div className="settings-export-actions">
              <button className="ghost-button" onClick={() => void exportCurrent("markdown")} disabled={!currentConversationId || busy}>导出 Markdown</button>
              <button className="ghost-button" onClick={() => void exportCurrent("json")} disabled={!currentConversationId || busy}>导出 JSON</button>
            </div>
            {!currentConversationId ? <small>打开或创建会话后可导出。</small> : null}
          </div>
          <div className="settings-danger"><button className="danger-button" onClick={() => void clearLocalConversations()}>清空所有本地会话</button></div>
          <div className="modal-actions"><button className="ghost-button" onClick={() => setShowSettings(false)}>取消</button><button className="primary-button" onClick={() => void saveSettingsDraft()} disabled={savingSettings}>{savingSettings ? "保存中…" : "保存设置"}</button></div>
        </section>
      </div> : null}
    </main>
  );
}
