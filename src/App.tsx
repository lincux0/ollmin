import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ProfilerOnRenderCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import "./index.css";
import {
  clearConversations,
  createConversationWithMessage,
  deleteConversation,
  exportConversation,
  getConversation,
  getModels,
  getServiceStatus,
  getSettings,
  listConversations,
  parseLocalAttachments,
  renameConversation,
  saveConversationAttachments,
  saveMessage,
  startChat,
  stopChat,
  updateSettings,
  warmModel,
} from "./api";
import MessageItem from "./components/MessageItem";
import { diagnosticsEnabled, installLongTaskObserver, recordDiagnostic, scheduleDiagnosticPaint } from "./lib/diagnostics";
import { trimHistoryForFastMode } from "./lib/history";
import { deriveChatMetrics, formatMetric } from "./lib/metrics";
import {
  CONTEXT_SIZE_OPTIONS,
  DEFAULT_CONTEXT_SIZE,
  DEFAULT_OUTPUT_TOKEN_LIMIT,
  DEFAULT_REASONING_TOKEN_LIMIT,
  OUTPUT_TOKEN_LIMIT_OPTIONS,
  PERFORMANCE_PROFILES,
  profileForMode,
  REASONING_TOKEN_LIMIT_OPTIONS,
  type ContextSize,
  type OutputTokenLimit,
  type PerformanceMode,
  type ReasoningTokenLimit,
} from "./lib/performance";
import { createStreamCoalescer, type StreamCoalescer } from "./lib/streaming";
import type {
  AttachmentSummary,
  AppSettings,
  ChatMessage,
  ChatMetrics,
  ChatResponse,
  ChatDiagnosticPayload,
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
  modelAlias?: string;
  attachments?: AttachmentSummary[];
}

interface AssistantBuffer {
  requestId: string;
  conversationId: string;
  id: string;
  content: string;
  thinking: string;
  metrics: ChatMetrics | null;
}

interface AssistantSnapshot {
  requestId: string;
  id: string;
  content: string;
  thinking: string;
  metrics: ChatMetrics | null;
  status: MessageStatus;
  error?: string;
  terminal: boolean;
}

interface SessionContextMenu {
  conversation: ConversationSummary;
  x: number;
  y: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  saveThinking: false,
  defaultMode: "fast",
  defaultModel: "",
  modelAliases: {},
  contextSize: DEFAULT_CONTEXT_SIZE,
  outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  reasoningTokenLimit: DEFAULT_REASONING_TOKEN_LIMIT,
};

const MAX_COMPOSER_ATTACHMENTS = 3;

function modelName(model: OllamaModel): string {
  return model.name ?? model.model ?? "未知模型";
}

function modelAlias(alias: string | undefined, model: string): string {
  return alias?.trim() || model;
}

function modelAliasFor(
  aliases: Record<string, string> | undefined,
  model: string,
  fallback?: string,
): string {
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, model)) {
    return modelAlias(aliases[model], model);
  }
  return modelAlias(fallback, model);
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

function fromStoredMessage(message: StoredMessage, alias?: string): ConversationMessage {
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

function responseMetrics(response: ChatResponse | undefined, startedAt: number): ChatMetrics | null {
  return response ? deriveChatMetrics(response, performance.now() - startedAt) : null;
}

function displayTime(value: string): string {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function attachmentDetail(attachment: AttachmentSummary): string {
  if (attachment.kind === "PDF") {
    return `${attachment.pageCount ?? 0} 页 · ${attachment.chunkCount} 个片段`;
  }
  if (attachment.kind === "DOCX") {
    return `${attachment.chunkCount} 个片段`;
  }
  const rows = attachment.sheets.reduce((total, sheet) => total + sheet.rows, 0);
  return `${attachment.sheets.length} 个工作表 · ${rows} 行`;
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
  const [currentModelAlias, setCurrentModelAlias] = useState("");
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
  const [modelAliasesExpanded, setModelAliasesExpanded] = useState(false);
  const [exportExpanded, setExportExpanded] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [parsingAttachments, setParsingAttachments] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenu | null>(null);
  const activeRequestId = useRef<string | null>(null);
  const requestConversationId = useRef<string | null>(null);
  const assistantBuffer = useRef<AssistantBuffer | null>(null);
  const streamCoalescer = useRef<StreamCoalescer<AssistantSnapshot> | null>(null);
  const streamEventCount = useRef(0);
  const lastStreamSequence = useRef<number | null>(null);
  const paintState = useRef(new Map<string, { first: boolean; twenty: boolean; terminal: boolean }>());
  const conversationIdRef = useRef<string | null>(null);
  const requestUserStartedAt = useRef(0);
  const requestStartedAt = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const followMessagesRef = useRef(true);
  const tauriWindowRef = useRef<TauriWindow | null>(null);
  const searchRef = useRef(search);
  searchRef.current = search;

  const applyAssistantSnapshot = useCallback((snapshot: AssistantSnapshot) => {
    if (snapshot.requestId !== activeRequestId.current) return;
    setMessages((current) => current.map((message) => message.id === snapshot.id
      ? {
          ...message,
          content: snapshot.content,
          thinking: snapshot.thinking || undefined,
          metrics: snapshot.metrics,
          status: snapshot.status,
          error: snapshot.error,
        }
      : message));

    recordDiagnostic(snapshot.requestId, "flush", {
      contentLength: snapshot.content.length,
      thinkingLength: snapshot.thinking.length,
      terminal: snapshot.terminal,
    });
    const state = paintState.current.get(snapshot.requestId) ?? { first: false, twenty: false, terminal: false };
    if ((snapshot.content || snapshot.thinking) && !state.first) {
      state.first = true;
      scheduleDiagnosticPaint(snapshot.requestId, "T5", {
        contentLength: snapshot.content.length,
        thinkingLength: snapshot.thinking.length,
      });
    }
    if (snapshot.content.length >= 20 && !state.twenty) {
      state.twenty = true;
      scheduleDiagnosticPaint(snapshot.requestId, "T6", { contentLength: snapshot.content.length });
    }
    if (snapshot.terminal && !state.terminal) {
      state.terminal = true;
      scheduleDiagnosticPaint(snapshot.requestId, "T7", {
        contentLength: snapshot.content.length,
        thinkingLength: snapshot.thinking.length,
      });
    }
    paintState.current.set(snapshot.requestId, state);
  }, []);

  const handleMessageRender = useCallback<ProfilerOnRenderCallback>(
    (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      if (!diagnosticsEnabled()) return;
      recordDiagnostic(activeRequestId.current ?? "global", "react-commit", {
        component: id,
        renderPhase: phase,
        actualDurationMs: Number(actualDuration.toFixed(2)),
        baseDurationMs: Number(baseDuration.toFixed(2)),
        renderStartMs: Number(startTime.toFixed(2)),
        commitMs: Number(commitTime.toFixed(2)),
      });
    },
    [],
  );

  const handleMessageListScroll = useCallback(() => {
    const element = messageListRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    followMessagesRef.current = distanceFromBottom < 72;
  }, []);

  const handleWindowDrag = useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    void tauriWindowRef.current?.startDragging().catch(() => undefined);
  }, []);

  const toggleWindowMaximize = useCallback(() => {
    void tauriWindowRef.current?.toggleMaximize().catch(() => undefined);
  }, []);

  const minimizeWindow = useCallback(() => {
    void tauriWindowRef.current?.minimize().catch(() => undefined);
  }, []);

  const closeWindow = useCallback(() => {
    void tauriWindowRef.current?.close().catch(() => undefined);
  }, []);

  useEffect(() => installLongTaskObserver(), []);
  useEffect(() => {
    try {
      tauriWindowRef.current = getCurrentWindow();
    } catch {
      // Browser preview/tests do not expose Tauri window internals.
      tauriWindowRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    const element = messageListRef.current;
    if (!element || !followMessagesRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (conversationIdRef.current || busy || models.length === 0) return;
    const configured = settings.defaultModel.trim();
    const preferred = configured && models.some((model) => modelName(model) === configured)
      ? configured
      : selectedModel && models.some((model) => modelName(model) === selectedModel)
        ? selectedModel
        : modelName(models[0]);
    if (preferred !== selectedModel) setSelectedModel(preferred);
    setCurrentModelAlias(modelAliasFor(settings.modelAliases, preferred));
  }, [busy, models, settings.defaultModel, settings.modelAliases, selectedModel]);

  useEffect(() => () => {
    streamCoalescer.current?.dispose();
    streamCoalescer.current = null;
  }, []);

  const refreshConnection = useCallback(async () => {
    try {
      const [service, modelResponse] = await Promise.all([
        getServiceStatus(),
        getModels(),
      ]);
      const nextModels = modelResponse.models ?? [];
      setStatus(service);
      setModels(nextModels);
      if (nextModels.length === 0 && !conversationIdRef.current) {
        setSelectedModel("");
        setCurrentModelAlias("");
      }
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
    let unlistenChat: (() => void) | undefined;
    let unlistenDiagnostic: (() => void) | undefined;

    void listen<ChatDiagnosticPayload>("chat:diagnostic", ({ payload }) => {
      const details: Record<string, string | number | boolean | null> = { elapsedMs: payload.elapsed_ms };
      if (payload.first_byte_ms !== undefined) details.firstByteMs = payload.first_byte_ms;
      if (payload.first_line_ms !== undefined) details.firstLineMs = payload.first_line_ms;
      if (payload.first_emit_ms !== undefined) details.firstEmitMs = payload.first_emit_ms;
      if (payload.final_emit_ms !== undefined) details.finalEmitMs = payload.final_emit_ms;
      if (payload.bytes_received !== undefined) details.bytesReceived = payload.bytes_received;
      if (payload.parsed_events !== undefined) details.parsedEvents = payload.parsed_events;
      if (payload.emitted_events !== undefined) details.emittedEvents = payload.emitted_events;
      recordDiagnostic(payload.request_id, `rust:${payload.phase}`, details);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlistenDiagnostic = cleanup;
    });

    void listen<ChatStreamPayload>("chat:chunk", ({ payload }) => {
      if (payload.request_id !== activeRequestId.current) return;
      const currentAssistantId = assistantBuffer.current?.id;
      const buffer = assistantBuffer.current;
      if (!currentAssistantId || !buffer) return;

      streamEventCount.current += 1;
      recordDiagnostic(payload.request_id, "T4", {
        sequence: payload.sequence ?? null,
        terminal: Boolean(payload.done || payload.error || payload.cancelled),
        elapsedFromT0Ms: performance.now() - requestUserStartedAt.current,
      });
      if (payload.sequence !== undefined) {
        const expected = (lastStreamSequence.current ?? 0) + 1;
        if (payload.sequence !== expected) {
          recordDiagnostic(payload.request_id, "sequence-gap", {
            expected,
            received: payload.sequence,
          });
        }
        lastStreamSequence.current = payload.sequence;
      }

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
      const terminal = Boolean(payload.done || payload.error || payload.cancelled);
      streamCoalescer.current?.enqueue({
        requestId: buffer.requestId,
        id: currentAssistantId,
        content: buffer.content,
        thinking: buffer.thinking,
        metrics: buffer.metrics,
        status: nextStatus,
        error: payload.error,
        terminal,
      }, {
        terminal,
        hasVisibleDelta: Boolean(payload.content || payload.thinking),
      });

      if (payload.error) setError(payload.error);
      if (payload.response) {
        setLastMetrics(buffer.metrics);
        setLastElapsedMs(performance.now() - requestStartedAt.current);
      }
      if (payload.done || payload.error || payload.cancelled) {
        const terminalBuffer = { ...buffer };
        const terminalEventCount = streamEventCount.current;
        const terminalUserStartedAt = requestUserStartedAt.current;
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
            .then(() => loadConversations(searchRef.current))
            .then(() => recordDiagnostic(terminalBuffer.requestId, "T8", {
              eventCount: terminalEventCount,
              contentLength: terminalBuffer.content.length,
              thinkingLength: terminalBuffer.thinking.length,
              elapsedFromT0Ms: performance.now() - terminalUserStartedAt,
            }))
            .catch((persistError) => {
              recordDiagnostic(terminalBuffer.requestId, "T8-error", {
                eventCount: terminalEventCount,
                elapsedFromT0Ms: performance.now() - terminalUserStartedAt,
              });
              setError(`保存回复失败：${errorText(persistError)}`);
            });
        } else {
          recordDiagnostic(terminalBuffer.requestId, "T8", {
            eventCount: terminalEventCount,
            elapsedFromT0Ms: performance.now() - terminalUserStartedAt,
          });
        }
        streamCoalescer.current?.flush();
        streamCoalescer.current?.dispose();
        streamCoalescer.current = null;
        activeRequestId.current = null;
        requestConversationId.current = null;
        assistantBuffer.current = null;
        setBusy(false);
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlistenChat = cleanup;
    });
    return () => {
      disposed = true;
      unlistenChat?.();
      unlistenDiagnostic?.();
      streamCoalescer.current?.dispose();
      streamCoalescer.current = null;
    };
  }, [applyAssistantSnapshot, loadConversations]);

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

  useEffect(() => {
    const closeContextMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSessionContextMenu(null);
    };
    window.addEventListener("keydown", closeContextMenu);
    return () => window.removeEventListener("keydown", closeContextMenu);
  }, []);

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
      const activeAlias = modelAliasFor(settings.modelAliases, detail.conversation.model, detail.conversation.modelAlias);
      setCurrentModelAlias(activeAlias);
      setMode(safeMode(detail.conversation.mode));
      followMessagesRef.current = true;
      const restored = detail.messages.map((message) => fromStoredMessage(message, activeAlias));
      setMessages(restored);
      setAttachments([]);
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
    const configuredModel = settings.defaultModel.trim();
    const nextModel = configuredModel && models.some((model) => modelName(model) === configuredModel)
      ? configuredModel
      : models.length > 0 ? modelName(models[0]) : "";
    setSelectedModel(nextModel);
    setCurrentModelAlias(modelAliasFor(settings.modelAliases, nextModel));
    setMode(settings.defaultMode);
    followMessagesRef.current = true;
    setMessages([]);
    setAttachments([]);
    setLastMetrics(null);
    setLastElapsedMs(null);
    setDraft("");
    setError(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!selectedModel || !text || busy || warming || loadingConversation) return;
    const activeModelAlias = modelAlias(currentModelAlias, selectedModel);
    const messageAttachments = attachments;

    const history: ChatMessage[] = [
      ...messages.filter((message) => message.role === "user" || message.role === "assistant").map(toChatMessage),
      { role: "user", content: text },
    ];
    const prepared = mode === "fast"
      ? trimHistoryForFastMode(history, profile.maxHistoryTokens).messages
      : history;
    const requestId = newId("chat");
    requestUserStartedAt.current = performance.now();
    recordDiagnostic(requestId, "T0", { mode, elapsedFromT0Ms: 0 });
    const conversationId = conversationIdRef.current ?? newId("conversation");
    const hadConversation = Boolean(conversationIdRef.current);
    const user: ConversationMessage = {
      id: newId("user"),
      role: "user",
      content: text,
      status: "done",
      createdAt: new Date().toISOString(),
      attachments: messageAttachments,
    };
    const assistant: ConversationMessage = {
      id: newId("assistant"),
      role: "assistant",
      content: "",
      status: "streaming",
      modelAlias: activeModelAlias,
    };
    const persistedUser: PersistedMessageInput = {
      id: user.id,
      conversationId,
      role: "user",
      content: user.content,
      thinking: null,
      status: "done",
      createdAt: user.createdAt,
    };

    setMessages((current) => [...current, user, assistant]);
    followMessagesRef.current = true;
    setDraft("");
    setAttachments([]);
    setError(null);
    setLastMetrics(null);
    setLastElapsedMs(null);
    setBusy(true);
    activeRequestId.current = requestId;
    requestConversationId.current = conversationId;
    assistantBuffer.current = { requestId, conversationId, id: assistant.id, content: "", thinking: "", metrics: null };
    streamEventCount.current = 0;
    lastStreamSequence.current = null;
    paintState.current.set(requestId, { first: false, twenty: false, terminal: false });
    streamCoalescer.current?.dispose();
    streamCoalescer.current = createStreamCoalescer(applyAssistantSnapshot);
    recordDiagnostic(requestId, "T1", {
      mode,
      elapsedFromT0Ms: performance.now() - requestUserStartedAt.current,
    });

    try {
      const storageStartedAt = performance.now();
      recordDiagnostic(requestId, "storage-start", {
        elapsedFromT0Ms: storageStartedAt - requestUserStartedAt.current,
        newConversation: !conversationIdRef.current,
      });
      if (!conversationIdRef.current) {
        conversationIdRef.current = conversationId;
        setCurrentConversationId(conversationId);
        const detail = await createConversationWithMessage(
          conversationId,
          selectedModel,
          mode,
          persistedUser,
          undefined,
          activeModelAlias,
        );
        if (!searchRef.current.trim()) {
          setConversations((current) => [
            detail.conversation,
            ...current.filter((conversation) => conversation.id !== detail.conversation.id),
          ]);
        }
        setCurrentModelAlias(detail.conversation.modelAlias);
      } else {
        await saveMessage(persistedUser);
      }
      recordDiagnostic(requestId, "storage-done", {
        storageMs: performance.now() - storageStartedAt,
        elapsedFromT0Ms: performance.now() - requestUserStartedAt.current,
      });
      requestStartedAt.current = performance.now();
      if (messageAttachments.length > 0) {
        await saveConversationAttachments(
          conversationId,
          user.id,
          messageAttachments.map((attachment) => attachment.id),
        );
      }
      recordDiagnostic(requestId, "T2-invoke", {
        mode,
        elapsedFromT0Ms: requestStartedAt.current - requestUserStartedAt.current,
      });
      await startChat(
        selectedModel,
        prepared,
        mode,
        requestId,
        settings.contextSize,
        settings.outputTokenLimit,
        settings.reasoningTokenLimit,
        conversationId,
        messageAttachments.map((attachment) => attachment.id),
      );
      recordDiagnostic(requestId, "T2-invoke-return", {
        invokeMs: performance.now() - requestStartedAt.current,
        elapsedFromT0Ms: performance.now() - requestUserStartedAt.current,
      });
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
      streamCoalescer.current?.dispose();
      streamCoalescer.current = null;
      setBusy(false);
    }
  }

  async function addLocalAttachments() {
    if (busy || warming || loadingConversation || parsingAttachments) return;
    const remaining = MAX_COMPOSER_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      setError(`一次最多保留 ${MAX_COMPOSER_ATTACHMENTS} 个已解析文件，请先移除不需要的文件。`);
      return;
    }
    try {
      const selected = await open({
        title: "添加本地文件",
        multiple: true,
        directory: false,
        filters: [{ name: "支持的文件", extensions: ["pdf", "docx", "xls", "xlsx"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length > remaining) {
        setError(`还可添加 ${remaining} 个文件，请分批选择或先移除已有文件。`);
        return;
      }
      setParsingAttachments(true);
      setError(null);
      const parsed = await parseLocalAttachments(paths);
      setAttachments((current) => [...current, ...parsed]);
    } catch (attachmentError) {
      setError(errorText(attachmentError));
    } finally {
      setParsingAttachments(false);
    }
  }

  function removeLocalAttachment(id: string) {
    if (parsingAttachments) return;
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
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

  async function copyMessage(message: Pick<ConversationMessage, "id" | "content">) {
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
      setSessionContextMenu(null);
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
      if (!busy && !conversationIdRef.current) {
        setMode(saved.defaultMode);
        const configuredModel = saved.defaultModel.trim();
        const nextModel = configuredModel && models.some((model) => modelName(model) === configuredModel)
          ? configuredModel
          : models.length > 0 ? modelName(models[0]) : "";
        setSelectedModel(nextModel);
        setCurrentModelAlias(modelAliasFor(saved.modelAliases, nextModel));
      } else if (selectedModel) {
        const activeAlias = modelAliasFor(saved.modelAliases, selectedModel, currentModelAlias);
        setCurrentModelAlias(activeAlias);
        setMessages((current) => current.map((message) => message.role === "assistant"
          ? { ...message, modelAlias: activeAlias }
          : message));
      }
      setShowSettings(false);
    } catch (settingsError) {
      setError(errorText(settingsError));
    } finally {
      setSavingSettings(false);
    }
  }

  const submitDisabled = !selectedModel || !draft.trim() || busy || warming || loadingConversation;

  return (
    <div className="app-window" onClick={() => setSessionContextMenu(null)}>
      <header className="window-bar">
        <div
          className="window-drag-region"
          data-tauri-drag-region
          onMouseDown={handleWindowDrag}
          onDoubleClick={toggleWindowMaximize}
        >
          <span className="window-brand-mark">O</span>
          <strong>Ollmin</strong>
          <span>本地 Ollama</span>
        </div>
        <div className="window-controls" aria-label="窗口控制">
          <button type="button" className="window-control" title="最小化" aria-label="最小化" onMouseDown={(event) => event.stopPropagation()} onClick={minimizeWindow}>−</button>
          <button type="button" className="window-control" title="最大化" aria-label="最大化" onMouseDown={(event) => event.stopPropagation()} onClick={toggleWindowMaximize}>□</button>
          <button type="button" className="window-control close" title="关闭" aria-label="关闭" onMouseDown={(event) => event.stopPropagation()} onClick={closeWindow}>×</button>
        </div>
      </header>

    <main className="chat-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">O</div>
          <div>
            <h1>Ollmin</h1>
          </div>
        </div>

        <div className="sidebar-top-row">
          <button className="primary-button new-chat-button" onClick={startNewConversation} disabled={busy}>＋ 新建对话 <span>Ctrl+N</span></button>
          <div className={`status-pill ${status ? "online" : "offline"}`}>
            <span className="status-dot" />
            {status ? `Ollama ${status.version ?? "已连接"}` : "Ollama 未连接"}
          </div>
        </div>

        <div className="session-tools">
          <label htmlFor="conversation-search">本地会话</label>
          <input id="conversation-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、模型或消息" />
        </div>
        <div className="session-list">
          {conversations.length === 0 ? <p className="session-empty">还没有保存的会话</p> : conversations.map((conversation) => (
            <div
              className={`session-item ${conversation.id === currentConversationId ? "selected" : ""}`}
              key={conversation.id}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const menuWidth = 150;
                const menuHeight = 46;
                setSessionContextMenu({
                  conversation,
                  x: Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8)),
                  y: Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8)),
                });
              }}
            >
              <button className="session-main" onClick={() => void selectConversation(conversation)} disabled={busy || loadingConversation}>
                <strong>{conversation.title}</strong>
                <small>{modelAliasFor(settings.modelAliases, conversation.model, conversation.modelAlias)} · {conversation.messageCount} 条 · {displayTime(conversation.updatedAt)}</small>
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <button className="ghost-button warm-button" onClick={() => void runWarmup()} disabled={!selectedModel || warming || busy}>
            {warming ? "预热中…" : "常驻"}
          </button>
          <button className="ghost-button" onClick={() => { setSettingsDraft(settings); setModelAliasesExpanded(false); setShowSettings(true); }} disabled={busy}>设置</button>
        </div>
      </aside>

      <section className="conversation-panel">
        <header className="conversation-header">
          <div>
            <p className="section-kicker">{selectedConversation?.title ?? "新对话"}</p>
            <h2>{currentModelAlias || selectedModel || "选择一个本地模型"}</h2>
          </div>
          <div className="conversation-header-actions">
            <span className="context-size" title={`当前会话使用的上下文窗口：${settings.contextSize.toLocaleString()} token`}>上下文 {settings.contextSize.toLocaleString()} token</span>
            {currentConversationId ? <>
              <button className="header-button" onClick={renameCurrentConversation} disabled={busy}>重命名</button>
            </> : null}
            {lastMetrics ? <div className="compact-metrics"><span>{formatMetric(lastMetrics.outputTokensPerSecond, 1)} tok/s</span><span>{formatMetric(lastElapsedMs, 0)} ms</span></div> : null}
          </div>
        </header>

        {error ? <div className="error-box"><strong>请求提示</strong><span>{error}</span><small>本地数据保存在应用数据目录；Ollama 仅连接 127.0.0.1:11434。</small></div> : null}

        <Profiler id="message-list" onRender={handleMessageRender}>
          <div ref={messageListRef} className="message-list" onScroll={handleMessageListScroll} aria-live="polite">
            {loadingConversation ? <div className="empty-state"><div className="empty-icon">…</div><h3>正在恢复会话</h3></div> : messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">⌁</div>
                <h3>开始一段本地对话</h3>
                <p>会话会保存在本机 SQLite。快速模式默认关闭思考并严格裁剪历史；思考内容默认不落盘。</p>
              </div>
            ) : messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                copied={copiedId === message.id}
                onCopy={copyMessage}
              />
            ))}
          </div>
        </Profiler>

        {lastMetrics ? <div className="metrics-strip"><span>加载 {formatMetric(lastMetrics.loadMs, 0)} ms</span><span>提示词 {lastMetrics.promptTokens ?? "—"} token · {formatMetric(lastMetrics.promptMs, 0)} ms</span><span>输出 {lastMetrics.outputTokens ?? "—"} token · 思考字符 {lastMetrics.thinkingCharacters}</span>{lastMetrics.stopReason === "length" ? <span className="metrics-warning" title="Ollama 因达到 num_predict 上限结束生成">已达到输出上限</span> : null}</div> : null}

        <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          {attachments.length > 0 ? <div className="composer-attachments" aria-label="已解析附件">
            {attachments.map((attachment) => (
              <div className="attachment-chip" key={attachment.id} title={attachment.warnings.join("\n") || attachment.name}>
                <div className="attachment-chip-copy">
                  <strong>{attachment.kind} · {attachment.name}</strong>
                  <small>{attachmentDetail(attachment)} · 已本地解析</small>
                </div>
                <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => void removeLocalAttachment(attachment.id)} disabled={parsingAttachments}>×</button>
              </div>
            ))}
            <p>发送时会按当前问题选取有限片段作为本地参考资料；完整文件不会上传。</p>
          </div> : null}
          <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={selectedModel ? "输入消息，Enter 发送，Shift+Enter 换行" : "先选择一个本地模型"} disabled={!selectedModel || warming || loadingConversation} rows={3} />
          <div className="composer-toolbar">
            <div className="composer-selection" aria-label="模型与性能模式">
              <button type="button" className="composer-file-button" onClick={() => void addLocalAttachments()} disabled={busy || warming || loadingConversation || parsingAttachments}>{parsingAttachments ? "解析中…" : "+ 文件"}</button>
              <span className="composer-selection-divider" aria-hidden="true">·</span>
              <select className="composer-select" aria-label="模型" value={selectedModel} onChange={(event) => { const nextModel = event.target.value; setSelectedModel(nextModel); setCurrentModelAlias(modelAliasFor(settings.modelAliases, nextModel)); }} disabled={busy || warming || models.length === 0 || messages.length > 0}>
                {models.length === 0 ? <option value="">没有检测到模型</option> : null}
                {models.map((model) => {
                  const name = modelName(model);
                  return <option key={name} value={name}>{modelAliasFor(settings.modelAliases, name, name === selectedModel ? currentModelAlias : undefined)}</option>;
                })}
              </select>
              <span className="composer-selection-divider" aria-hidden="true">·</span>
              <select className="composer-select mode-select" aria-label="性能模式" value={mode} onChange={(event) => setMode(event.target.value as PerformanceMode)} disabled={busy || warming || loadingConversation}>
                {Object.values(PERFORMANCE_PROFILES).map((item) => <option key={item.mode} value={item.mode}>{item.label}</option>)}
              </select>
            </div>
            <div className="composer-toolbar-actions">
              <span className="composer-status">{busy ? "正在接收本地流… · Esc 停止" : ""}</span>
              {busy ? <button type="button" className="stop-button" onClick={() => void cancelMessage()}>停止</button> : null}
              <button type="submit" className="send-button" aria-label={busy ? "生成中" : "发送"} disabled={submitDisabled}>{busy ? "…" : "↑"}</button>
            </div>
          </div>
        </form>
      </section>

      {sessionContextMenu ? (
        <div
          className="session-context-menu"
          role="menu"
          style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void removeConversation(sessionContextMenu.conversation)}
            disabled={busy}
          >
            删除会话
          </button>
        </div>
      ) : null}

      {showSettings ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSettings(false)}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="section-kicker">本地设置</p><h2 id="settings-title">Ollmin 设置</h2></div><button className="modal-close" onClick={() => setShowSettings(false)}>×</button></div>
          <div className="settings-connection">
            <button className="ghost-button" onClick={() => void refreshConnection()} disabled={busy || warming}>刷新连接</button>
            <span>{status ? `Ollama ${status.version ?? "已连接"}` : "Ollama 未连接"}</span>
          </div>
          <div className="settings-grid">
            <div className="settings-field">
              <label htmlFor="theme">主题</label>
              <select id="theme" value={settingsDraft.theme} onChange={(event) => setSettingsDraft((current) => ({ ...current, theme: event.target.value as ThemeMode }))}>
                <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
              </select>
            </div>
            <div className="settings-field">
              <label htmlFor="default-mode">默认性能模式</label>
              <select id="default-mode" value={settingsDraft.defaultMode} onChange={(event) => setSettingsDraft((current) => ({ ...current, defaultMode: event.target.value as PerformanceMode }))}>
                {Object.values(PERFORMANCE_PROFILES).map((item) => <option key={item.mode} value={item.mode}>{item.label}</option>)}
              </select>
            </div>
          </div>
          <div className="settings-grid">
            <div className="settings-field">
              <label htmlFor="settings-model">新会话模型</label>
              <select id="settings-model" value={settingsDraft.defaultModel} onChange={(event) => setSettingsDraft((current) => ({ ...current, defaultModel: event.target.value }))}>
                <option value="">自动选择第一个可用模型</option>
                {models.map((model) => {
                  const name = modelName(model);
                  return <option key={name} value={name}>{modelAliasFor(settingsDraft.modelAliases, name)}</option>;
                })}
              </select>
            </div>
            <div className="settings-field">
              <label htmlFor="context-size">上下文大小</label>
              <select
                id="context-size"
                value={settingsDraft.contextSize}
                onChange={(event) => setSettingsDraft((current) => ({
                  ...current,
                  contextSize: Number(event.target.value) as ContextSize,
                }))}
              >
                {CONTEXT_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size / 1024}K</option>)}
              </select>
            </div>
          </div>
          <div className="settings-grid">
            <div className="settings-field">
              <label htmlFor="output-token-limit">输出消息 token 上限</label>
              <select
                id="output-token-limit"
                value={settingsDraft.outputTokenLimit}
                onChange={(event) => setSettingsDraft((current) => ({
                  ...current,
                  outputTokenLimit: Number(event.target.value) as OutputTokenLimit,
                }))}
              >
                {OUTPUT_TOKEN_LIMIT_OPTIONS.map((limit) => <option key={limit} value={limit}>{limit / 1024}K</option>)}
              </select>
            </div>
            <div className="settings-field">
              <label htmlFor="reasoning-token-limit">推理输出 token 上限</label>
              <select
                id="reasoning-token-limit"
                value={settingsDraft.reasoningTokenLimit}
                onChange={(event) => setSettingsDraft((current) => ({
                  ...current,
                  reasoningTokenLimit: Number(event.target.value) as ReasoningTokenLimit,
                }))}
              >
                {REASONING_TOKEN_LIMIT_OPTIONS.map((limit) => <option key={limit} value={limit}>{limit === 0 ? "不限" : `${limit / 1024}K`}</option>)}
              </select>
            </div>
          </div>
          <p className="settings-note">推理上限仅在开启思考的模式中生效；快速模式关闭思考，“不限”表示不额外限制推理输出。Ollama 会将推理与正文计入同一生成预算，Ollmin 按两项上限合并分配。</p>
          <div className="settings-disclosure-row">
            <button
              type="button"
              className="settings-disclosure"
              aria-expanded={modelAliasesExpanded}
              onClick={() => setModelAliasesExpanded((expanded) => !expanded)}
            >
              <span>模型别名</span>
              <span aria-hidden="true">{modelAliasesExpanded ? "⌃" : "⌄"}</span>
            </button>
            <button
              type="button"
              className="settings-disclosure"
              aria-expanded={exportExpanded}
              onClick={() => setExportExpanded((expanded) => !expanded)}
            >
              <span>导出当前会话</span>
              <span aria-hidden="true">{exportExpanded ? "⌃" : "⌄"}</span>
            </button>
          </div>
          {modelAliasesExpanded ? <div className="model-alias-list">
            {models.length === 0 ? <p className="settings-note">暂无可用模型，请先刷新连接。</p> : models.map((model) => {
                const name = modelName(model);
                const alias = Object.prototype.hasOwnProperty.call(settingsDraft.modelAliases, name)
                  ? settingsDraft.modelAliases[name]
                  : "";
                return (
                  <div className="model-alias-row" key={name}>
                    <span className="model-alias-name" title={name}>{name}</span>
                    <input
                      aria-label={`${name} 的别名`}
                      value={alias}
                      maxLength={80}
                      placeholder="使用原名"
                      onChange={(event) => setSettingsDraft((current) => ({
                        ...current,
                        modelAliases: { ...current.modelAliases, [name]: event.target.value },
                      }))}
                    />
                  </div>
                );
              })}
          </div> : null}
          {exportExpanded ? <div className="settings-export">
            <div className="settings-export-actions">
              <button className="ghost-button" onClick={() => void exportCurrent("markdown")} disabled={!currentConversationId || busy}>导出 Markdown</button>
              <button className="ghost-button" onClick={() => void exportCurrent("json")} disabled={!currentConversationId || busy}>导出 JSON</button>
            </div>
            {!currentConversationId ? <small>打开或创建会话后可导出。</small> : null}
          </div> : null}
          <label className="check-row"><input type="checkbox" checked={settingsDraft.saveThinking} onChange={(event) => setSettingsDraft((current) => ({ ...current, saveThinking: event.target.checked }))} />允许把思考内容保存到本地会话</label>
          <p className="settings-note">默认关闭。关闭后，新保存的消息只保留正文；已经保存的思考内容不会自动删除。</p>
          <div className="settings-danger"><button className="danger-button" onClick={() => void clearLocalConversations()}>清空所有本地会话</button></div>
          <div className="modal-actions"><button className="ghost-button" onClick={() => setShowSettings(false)}>取消</button><button className="primary-button" onClick={() => void saveSettingsDraft()} disabled={savingSettings}>{savingSettings ? "保存中…" : "保存设置"}</button></div>
        </section>
      </div> : null}
    </main>
    </div>
  );
}
