import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ProfilerOnRenderCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./index.css";
import "./features/chat/reading.css";
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
  releaseLocalAttachments,
  renameConversation,
  saveConversationAttachments,
  saveMessage,
  startChat,
  stopChat,
  updateSettings,
  warmModel,
} from "./api";
import MessageItem from "./components/MessageItem";
import Modal from "./components/ui/Modal";
import SessionSidebar, { type SessionSidebarHandle } from "./features/sessions/SessionSidebar";
import ChatWorkspace from "./features/chat/ChatWorkspace";
import { useSidebar } from "./features/shell/useSidebar";
import {
  errorText,
  fromStoredMessage,
  newId,
  responseMetrics,
  safeMode,
  toChatMessage,
} from "./features/chat/helpers";
import type {
  AssistantBuffer,
  AssistantSnapshot,
  ConversationMessage,
  MessageStatus,
} from "./features/chat/types";
import { MAX_COMPOSER_ATTACHMENTS } from "./features/attachments/helpers";
import Composer from "./features/chat/Composer";
import ModelPicker from "./features/chat/ModelPicker";
import SettingsDialog from "./features/settings/SettingsDialog";
import { readUiFontSize, writeUiFontSize, type UiFontSize } from "./features/settings/uiFontSize";
import { version as appVersion } from "../package.json";
import TurnNavigator from "./features/chat/TurnNavigator";
import { useChatReading } from "./features/chat/useChatReading";
import { modelAlias, modelAliasFor, modelName } from "./features/models/helpers";
import { DEFAULT_SETTINGS } from "./features/settings/defaults";
import { downloadExport } from "./features/shell/export";
import Icon from "./features/shell/Icon";
import WindowTitleBar from "./features/shell/WindowTitleBar";
import { applyThemePreference } from "./features/shell/theme";
import { diagnosticsEnabled, installLongTaskObserver, recordDiagnostic, scheduleDiagnosticPaint } from "./features/diagnostics/diagnostics";
import { trimHistoryForFastMode } from "./lib/history";
import { formatMetric } from "./lib/metrics";
import { shouldKeepConversationAfterStartFailure } from "./lib/session";
import {
  PERFORMANCE_PROFILES,
  profileForMode,
  type PerformanceMode,
} from "./lib/performance";
import { createStreamCoalescer, type StreamCoalescer } from "./lib/streaming";
import type {
  AttachmentSummary,
  AppSettings,
  ChatMessage,
  ChatMetrics,
  ChatDiagnosticPayload,
  ChatStreamPayload,
  ConversationDetail,
  ConversationSummary,
  ExportPayload,
  OllamaModel,
  PersistedMessageInput,
  ServiceStatus,
} from "./contracts/ipc";

export default function App() {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const connectionSequence = useRef(0);
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
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSequence = useRef(0);
  const sidebarRef = useRef<SessionSidebarHandle>(null);
  const sidebar = useSidebar();
  const [activeSummary, setActiveSummary] = useState<ConversationSummary | null>(null);
  const [dialog, setDialog] = useState<{ title: string; message?: string; value?: string; action: (value: string) => Promise<void> | void } | null>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [uiFontSize, setUiFontSize] = useState<UiFontSize>(readUiFontSize);
  const [uiFontSizeDraft, setUiFontSizeDraft] = useState<UiFontSize>(uiFontSize);
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [parsingAttachments, setParsingAttachments] = useState(false);
  const activeRequestId = useRef<string | null>(null);
  const requestConversationId = useRef<string | null>(null);
  const assistantBuffer = useRef<AssistantBuffer | null>(null);
  const streamCoalescer = useRef<StreamCoalescer<AssistantSnapshot> | null>(null);
  const streamEventCount = useRef(0);
  const lastStreamSequence = useRef<number | null>(null);
  const paintState = useRef(new Map<string, { first: boolean; twenty: boolean; terminal: boolean }>());
  const conversationIdRef = useRef<string | null>(null);
  const conversationLoadSequence = useRef(0);
  const requestUserStartedAt = useRef(0);
  const requestStartedAt = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const followMessagesRef = useRef(true);
  const reading = useChatReading(messageListRef, messageContentRef, followMessagesRef, messages, currentConversationId);
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

  useEffect(() => installLongTaskObserver(), []);

  useEffect(() => {
    if (initializing || conversationIdRef.current || busy || models.length === 0) return;
    const configured = settings.defaultModel.trim();
    const preferred = selectedModel && models.some((model) => modelName(model) === selectedModel)
      ? selectedModel
      : configured && models.some((model) => modelName(model) === configured)
        ? configured
        : modelName(models[0]);
    if (preferred !== selectedModel) setSelectedModel(preferred);
    setCurrentModelAlias(modelAliasFor(settings.modelAliases, preferred));
  }, [busy, initializing, models, settings.defaultModel, settings.modelAliases, selectedModel]);

  useEffect(() => () => {
    streamCoalescer.current?.dispose();
    streamCoalescer.current = null;
  }, []);

  const refreshConnection = useCallback(async () => {
      const sequence = ++connectionSequence.current;
      setLoadingModels(true);
      setModelsError(null);
      const [service, modelResponse] = await Promise.allSettled([
        getServiceStatus(),
        getModels(),
      ]);
      if (sequence !== connectionSequence.current) return;
      setStatus(service.status === "fulfilled" ? service.value : null);
      if (service.status === "rejected") setError(`Ollama 未连接：${errorText(service.reason)}`);
      const nextModels = modelResponse.status === "fulfilled" ? modelResponse.value.models ?? [] : [];
      setModels(nextModels);
      if (modelResponse.status === "rejected") setModelsError(`模型列表读取失败：${errorText(modelResponse.reason)}`);
      if (nextModels.length === 0 && !conversationIdRef.current) {
        setSelectedModel("");
        setCurrentModelAlias("");
      }
      setLoadingModels(false);
  }, []);

  const loadConversations = useCallback(async (query = "") => {
    const sequence = ++searchSequence.current;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const result = await listConversations(query.trim().slice(0, 500));
      if (sequence === searchSequence.current && query === searchRef.current) setConversations(result);
    } catch (conversationError) {
      if (sequence === searchSequence.current && query === searchRef.current) setSearchError(errorText(conversationError));
    } finally {
      if (sequence === searchSequence.current && query === searchRef.current) setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([refreshConnection(), getSettings().then((loadedSettings) => {
      if (disposed) return;
      setSettings(loadedSettings);
      setSettingsDraft(loadedSettings);
      setMode(loadedSettings.defaultMode);
    }).catch((settingsError) => { if (!disposed) setError(errorText(settingsError)); })])
      .finally(() => { if (!disposed) setInitializing(false); });
    return () => { disposed = true; };
  }, [refreshConnection]);

  useEffect(() => {
    // Invalidate immediately, including the 150ms debounce window.
    searchSequence.current += 1;
    setSearchLoading(true);
    setSearchError(null);
    const timer = window.setTimeout(() => void loadConversations(search), 150);
    return () => { window.clearTimeout(timer); searchSequence.current += 1; };
  }, [loadConversations, search]);

  useLayoutEffect(() => {
    return applyThemePreference(
      showSettings ? settingsDraft.theme : settings.theme,
      document.documentElement,
      window.matchMedia("(prefers-color-scheme: dark)"),
    );
  }, [settings.theme, settingsDraft.theme, showSettings]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--chat-font-size", `${showSettings ? uiFontSizeDraft : uiFontSize}px`);
    document.documentElement.style.setProperty("--chat-line-height", `${(showSettings ? uiFontSizeDraft : uiFontSize) + 10}px`);
  }, [showSettings, uiFontSize, uiFontSizeDraft]);

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
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault(); sidebar.expand();
        window.requestAnimationFrame(() => sidebarRef.current?.focusSearch());
      } else if (modifier && event.altKey && !event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault(); void renameCurrentConversation();
      } else if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (!busy && !loadingConversation) requestNewConversation();
      } else if (event.key === "Escape" && busy) {
        event.preventDefault();
        void cancelMessage();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  });

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === currentConversationId) ?? activeSummary,
    [conversations, currentConversationId, activeSummary],
  );
  const profile = profileForMode(mode);

  async function selectConversation(conversation: ConversationSummary) {
    if (busy || loadingConversation || conversation.id === currentConversationId) return;
    const loadSequence = conversationLoadSequence.current + 1;
    conversationLoadSequence.current = loadSequence;
    setLoadingConversation(true);
    setError(null);
    const stagedAttachmentIds = attachments.map((attachment) => attachment.id);
    if (stagedAttachmentIds.length > 0) {
      void releaseLocalAttachments(stagedAttachmentIds).catch(() => undefined);
    }
    setAttachments([]);
    try {
      const detail: ConversationDetail = await getConversation(conversation.id);
      if (loadSequence !== conversationLoadSequence.current) return;
      conversationIdRef.current = detail.conversation.id;
      setCurrentConversationId(detail.conversation.id);
      setActiveSummary(detail.conversation);
      setSelectedModel(detail.conversation.model);
      const activeAlias = modelAliasFor(settings.modelAliases, detail.conversation.model, detail.conversation.modelAlias);
      setCurrentModelAlias(activeAlias);
      setMode(safeMode(detail.conversation.mode));
      followMessagesRef.current = true;
      const restored = detail.messages.map((message) => fromStoredMessage(message, activeAlias));
      setMessages(restored);
      const lastWithMetrics = [...detail.messages].reverse().find((message) => message.metrics);
      setLastMetrics(lastWithMetrics?.metrics ?? null);
      setLastElapsedMs(lastWithMetrics?.metrics?.wallMs ?? null);
      setDraft("");
    } catch (loadError) {
      if (loadSequence === conversationLoadSequence.current) setError(errorText(loadError));
    } finally {
      if (loadSequence === conversationLoadSequence.current) {
        setLoadingConversation(false);
        window.setTimeout(() => composerRef.current?.focus(), 0);
      }
    }
  }

  function startNewConversation() {
    if (busy || loadingConversation) return;
    conversationLoadSequence.current += 1;
    const stagedAttachmentIds = attachments.map((attachment) => attachment.id);
    if (stagedAttachmentIds.length > 0) {
      void releaseLocalAttachments(stagedAttachmentIds).catch(() => undefined);
    }
    conversationIdRef.current = null;
    setCurrentConversationId(null);
    setActiveSummary(null);
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
    if (!status || !models.some((model) => modelName(model) === selectedModel) || !text || activeRequestId.current || busy || warming || loadingConversation || initializing || parsingAttachments || loadingModels) return;
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
    let conversationPersisted = hadConversation;
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
        const detail = await createConversationWithMessage(
          conversationId,
          selectedModel,
          mode,
          persistedUser,
          undefined,
          activeModelAlias,
        );
        conversationPersisted = true;
        conversationIdRef.current = conversationId;
        setCurrentConversationId(conversationId);
        setActiveSummary(detail.conversation);
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
      if (!shouldKeepConversationAfterStartFailure(hadConversation, conversationPersisted)) {
        conversationIdRef.current = null;
        setCurrentConversationId(null);
      }
      if (messageAttachments.length > 0) {
        void releaseLocalAttachments(messageAttachments.map((attachment) => attachment.id)).catch(() => undefined);
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
    void releaseLocalAttachments([id]).catch(() => undefined);
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
      setCopiedId((current) => current === message.id ? null : current);
      setError(`复制失败：${errorText(copyError)}`);
      throw copyError;
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

  function openDialog(next: NonNullable<typeof dialog>) {
    setDialogValue(next.value ?? ""); setDialogError(null); setDialog(next);
  }

  function protectDraft(action: () => void) {
    if (!draft.trim() && attachments.length === 0) { action(); return; }
    openDialog({ title: "放弃当前草稿？", message: "未发送的文本和附件将被清除。", action });
  }

  function requestNewConversation() { protectDraft(startNewConversation); }
  function requestSelectConversation(conversation: ConversationSummary) {
    if (conversation.id === currentConversationId) { composerRef.current?.focus(); return; }
    protectDraft(() => { void selectConversation(conversation); });
  }

  function renameCurrentConversation(conversation = selectedConversation) {
    if (!conversation || busy) return;
    openDialog({ title: "重命名会话", value: conversation.title, action: async (value) => {
      if (!value.trim()) throw new Error("请输入会话名称");
      await renameConversation(conversation.id, value.trim());
      if (conversation.id === conversationIdRef.current) setActiveSummary({ ...conversation, title: value.trim() });
      await loadConversations(searchRef.current);
    } });
  }

  async function removeConversation(conversation: ConversationSummary) {
    if (busy || loadingConversation) return;
    openDialog({ title: "删除会话？", message: `“${conversation.title}”及其中的消息将从本机删除，无法撤销。${conversation.id === currentConversationId && (draft.trim() || attachments.length) ? "当前未发送的草稿和附件也将被放弃。" : ""}`, action: async () => {
      await deleteConversation(conversation.id);
      if (conversation.id === conversationIdRef.current) startNewConversation();
      await loadConversations(searchRef.current);
    } });
  }

  async function exportSession(conversation: ConversationSummary, format: ExportPayload["format"]) {
    try { downloadExport(await exportConversation(conversation.id, format)); }
    catch (exportError) { setError(errorText(exportError)); }
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
    if (busy || loadingConversation) return;
    openDialog({ title: "清空本地会话？", message: "所有会话和消息将被删除，无法撤销。当前未发送的草稿和附件也将被放弃。设置不会被删除。", action: async () => {
      await clearConversations();
      startNewConversation();
      await loadConversations(searchRef.current);
      setShowSettings(false);
    } });
  }

  function closeSettings() {
    if (JSON.stringify(settingsDraft) !== JSON.stringify(settings) || uiFontSizeDraft !== uiFontSize) {
      openDialog({ title: "放弃设置修改？", message: "尚未保存的设置将被放弃。", action: () => setShowSettings(false) });
    } else setShowSettings(false);
  }

  async function saveSettingsDraft(draftSettings: AppSettings, draftFont: UiFontSize) {
    const changedFont = draftFont !== uiFontSize;
    if (changedFont) writeUiFontSize(draftFont);
    try {
      const saved = await updateSettings(draftSettings);
      setUiFontSize(draftFont);
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
    } catch (settingsError) {
      if (changedFont) {
        try { writeUiFontSize(uiFontSize); }
        catch (restoreError) { throw new Error(`设置未保存，旧字号恢复失败：${errorText(restoreError)}`); }
      }
      throw settingsError;
    }
  }

  const settling = initializing || loadingConversation;
  const hero = messages.length === 0 && !settling;
  const pickerProps = {
    models: models.map(modelName), selectedModel, modelAliases: settings.modelAliases, currentModelAlias,
    mode, busy: busy || warming || settling || parsingAttachments, modelLocked: messages.length > 0,
    loadingModels, modelsError, onRetryModels: () => void refreshConnection(),
    onSelectModel: (name: string) => {
      if (busy || warming || settling || messages.length > 0) return;
      if (!models.some((model) => modelName(model) === name)) { setModelsError("所选模型已不可用，请刷新模型列表。"); return; }
      setSelectedModel(name); setCurrentModelAlias(modelAliasFor(settings.modelAliases, name));
    },
    onSelectMode: (next: PerformanceMode) => { if (!busy && !warming && !settling) setMode(next); },
  };

  return (
    <div className={`app-window ${initializing ? "initializing" : ""}`}>
      <WindowTitleBar onToggleSidebar={sidebar.toggle} sidebarCollapsed={sidebar.collapsed} onNewChat={requestNewConversation} newChatDisabled={busy || loadingConversation} onSearch={() => { sidebar.expand(); requestAnimationFrame(() => sidebarRef.current?.focusSearch()); }} />

    <main className={`chat-shell ${sidebar.collapsed ? "sidebar-collapsed" : ""} ${sidebar.animating ? "sidebar-animating" : ""}`} style={{ "--sidebar-width": `${sidebar.collapsed ? 0 : sidebar.width}px` } as CSSProperties}>
      <SessionSidebar ref={sidebarRef}
        conversations={conversations} selectedConversationId={currentConversationId} modelAliases={settings.modelAliases}
        search={search} searchLoading={searchLoading} searchError={searchError} collapsed={sidebar.collapsed}
        disabled={busy || loadingConversation} online={Boolean(status)} statusLabel={status ? `Ollama ${status.version ?? "已连接"}` : "Ollama 未连接"}
        selectedModel={selectedModel} warming={warming}
        onSearchChange={setSearch} onRetrySearch={() => void loadConversations(search)}
        onSelectConversation={requestSelectConversation} onRenameConversation={renameCurrentConversation}
        onDeleteConversation={removeConversation} onExportConversation={exportSession}
        onWarmup={() => void runWarmup()}
        onOpenSettings={() => { setSettingsDraft(settings); setUiFontSizeDraft(uiFontSize); setShowSettings(true); }} />
      {!sidebar.collapsed ? <div className="sidebar-resize-handle" {...sidebar.resizeProps} /> : null}
      <ChatWorkspace stage={settling ? "settling" : hero ? "hero" : "active"}>
        <header className="conversation-header">
          <h2>{selectedConversation?.title ?? "新对话"}</h2>
          <div className="conversation-header-actions">
            <span className="context-size" title={`当前会话使用的上下文窗口：${settings.contextSize.toLocaleString()} token`}>上下文 {settings.contextSize.toLocaleString()} token</span>
            {currentConversationId ? <>
              <button className="header-button" onClick={() => renameCurrentConversation()} disabled={busy}>重命名</button>
            </> : null}
            {lastMetrics ? <div className="compact-metrics"><span>{formatMetric(lastMetrics.outputTokensPerSecond, 1)} tok/s</span><span>{formatMetric(lastElapsedMs, 0)} ms</span></div> : null}
          </div>
        </header>

        {error ? <div className="error-box" role="alert"><strong>请求提示</strong><span>{error}</span><small>本地会话保存在本机；请确认 Ollama 已在 127.0.0.1:11434 运行。</small></div> : null}

        <Profiler id="message-list" onRender={handleMessageRender}>
          <div className="reading-area">
          <div ref={messageListRef} className="message-list" onScroll={reading.onScroll}>
            <div ref={messageContentRef} className="message-stack">
            {settling ? <div className="empty-state" role="status"><h3>{initializing ? "正在读取本地设置" : "正在恢复会话"}</h3></div> : messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                copied={copiedId === message.id}
                copiedThinking={copiedId === `${message.id}:thinking`}
                onCopy={copyMessage}
              />
            ))}
            </div>
          </div>
          {!settling && !hero ? <TurnNavigator messages={messages} currentId={reading.currentTurn} onSelect={reading.jumpToTurn} /> : null}
          </div>
        </Profiler>
        {reading.away && !settling && !hero ? <button type="button" className="jump-latest" onClick={reading.jumpToLatest}>回到最新 ↓</button> : null}

        <div className="hero-heading" aria-hidden={!hero}>
          <h1>开始一段本地对话</h1>
          <p>有什么想和 Ollmin 聊聊？</p>
        </div>
        <Composer draft={draft} setDraft={setDraft} textareaRef={composerRef} hero={hero}
          fontSize={showSettings ? uiFontSizeDraft : uiFontSize}
          busy={busy} online={Boolean(status) && !loadingModels} hasModel={models.some((model) => modelName(model) === selectedModel)}
          warming={warming} loadingConversation={settling} parsingAttachments={parsingAttachments} attachments={attachments}
          onSubmit={sendMessage} onStop={cancelMessage} onAddAttachments={addLocalAttachments} onRemoveAttachment={removeLocalAttachment}
          modelControl={<ModelPicker {...pickerProps} kind="combined" />} />
        <div className="composer-feedback" role="status">
          {warming ? "正在本机预热模型…" : parsingAttachments ? "" : busy ? "正在接收本地流 · Esc 停止" : loadingModels ? "正在读取本机模型…" : modelsError ? <><span>{modelsError}</span><button type="button" onClick={() => void refreshConnection()}>重试</button></> : !status ? <><span>Ollama 未连接</span><button type="button" onClick={() => void refreshConnection()}>刷新连接</button></> : models.length === 0 ? <><span>没有检测到本地模型</span><button type="button" onClick={() => void refreshConnection()}>刷新模型</button></> : !models.some((model) => modelName(model) === selectedModel) ? "当前会话模型不可用，请在 Ollama 中安装该模型。" : ""}
        </div>
      </ChatWorkspace>

      {showSettings ? <SettingsDialog settings={settingsDraft} onSettingsChange={setSettingsDraft}
        uiFontSize={uiFontSizeDraft} onUiFontSizeChange={setUiFontSizeDraft} models={models.map(modelName)}
        appVersion={appVersion} serviceStatus={status ? `Ollama ${status.version ?? "已连接"}` : "Ollama 未连接"}
        currentConversationId={currentConversationId} busy={busy || warming || loadingConversation || loadingModels}
        onRefreshConnection={() => void refreshConnection()} onWarmup={runWarmup} onExport={exportCurrent}
        onClearConversations={clearLocalConversations} onRequestClose={closeSettings}
        onSave={saveSettingsDraft} onSavedClose={() => setShowSettings(false)} /> : null}
      {dialog ? <Modal onClose={() => { if (!dialogBusy) setDialog(null); }} labelledBy="action-dialog-title" className="action-modal">
        <h2 id="action-dialog-title">{dialog.title}</h2>
        {dialog.message ? <p>{dialog.message}</p> : null}
        <form onSubmit={async (event) => {
          event.preventDefault(); if (dialogBusy) return;
          setDialogBusy(true); setDialogError(null);
          try { await dialog.action(dialogValue); setDialog(null); }
          catch (actionError) { setDialogError(errorText(actionError)); }
          finally { setDialogBusy(false); }
        }}>
          {dialog.value !== undefined ? <label>会话名称<input value={dialogValue} maxLength={200} onChange={(event) => setDialogValue(event.target.value)} disabled={dialogBusy} /></label> : null}
          {dialogError ? <p role="alert">{dialogError}</p> : null}
          <div className="modal-actions"><button type="button" className="ghost-button" onClick={() => setDialog(null)} disabled={dialogBusy}>取消</button><button type="submit" className="primary-button" disabled={dialogBusy}>{dialogBusy ? "处理中…" : "确认"}</button></div>
        </form>
      </Modal> : null}
    </main>
    </div>
  );
}
