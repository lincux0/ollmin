import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ConversationSummary } from "../../contracts/ipc";
import { modelAliasFor } from "../models/helpers";
import { displayTime } from "./helpers";
import MenuSurface, { type MenuAnchor } from "../../components/ui/MenuSurface";
import StatusPill from "../../components/ui/StatusPill";

export interface SessionSidebarHandle {
  focusSearch(): void;
}

export interface SessionSidebarProps {
  conversations: ConversationSummary[];
  selectedConversationId: string | null;
  modelAliases: Record<string, string>;
  search: string;
  searchLoading: boolean;
  searchError: string | null;
  collapsed?: boolean;
  disabled?: boolean;
  loadingConversation?: boolean;
  statusLabel: string;
  online: boolean;
  selectedModel: string;
  warming: boolean;
  onSearchChange: (value: string) => void;
  onRetrySearch: () => void;
  onSelectConversation: (conversation: ConversationSummary) => void;
  onRenameConversation: (conversation: ConversationSummary) => void;
  onDeleteConversation: (conversation: ConversationSummary) => void;
  onExportConversation: (conversation: ConversationSummary, format: "markdown" | "json") => void;
  onWarmup: () => void;
  onOpenSettings: () => void;
}

const SessionSidebar = forwardRef<SessionSidebarHandle, SessionSidebarProps>(function SessionSidebar(props, forwardedRef) {
  const {
    conversations, selectedConversationId, modelAliases, search, searchLoading, searchError,
    disabled = false, collapsed = false, loadingConversation = false, statusLabel, online, selectedModel, warming,
    onSearchChange, onRetrySearch, onSelectConversation, onRenameConversation,
    onDeleteConversation, onExportConversation, onWarmup, onOpenSettings,
  } = props;
  const searchRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const searchAreaRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLElement>(null);
  const restoreMenuFocusRef = useRef(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<{ conversation: ConversationSummary; anchor: MenuAnchor } | null>(null);
  useLayoutEffect(() => { if (searchOpen && !collapsed) searchRef.current?.focus(); }, [searchOpen, collapsed]);

  useImperativeHandle(forwardedRef, () => ({
    focusSearch() {
      searchTriggerRef.current = document.querySelector<HTMLButtonElement>('.window-leading-actions [aria-label="搜索会话"]');
      setSearchOpen(true);
      searchRef.current?.focus();
    },
  }), []);

  useEffect(() => {
    if (!searchOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !searchAreaRef.current?.contains(event.target) && !searchTriggerRef.current?.contains(event.target)) {
        onSearchChange("");
        setSearchOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [searchOpen, onSearchChange]);

  const openMenu = (conversation: ConversationSummary, anchor: MenuAnchor, trigger: HTMLElement) => {
    restoreMenuFocusRef.current = true;
    menuTriggerRef.current = trigger;
    setMenu({ conversation, anchor });
  };
  const closeMenu = () => setMenu(null);
  const runMenuAction = (action: () => void) => {
    menuTriggerRef.current?.focus();
    closeMenu();
    action();
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      event.preventDefault();
      onSearchChange("");
      setSearchOpen(false);
      requestAnimationFrame(() => searchTriggerRef.current?.focus());
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-top-row">
        <StatusPill online={online} label={statusLabel} />
      </div>

      <div className="session-tools" ref={searchAreaRef}>
        {searchOpen ? <input ref={searchRef} id="conversation-search" value={search} maxLength={500} onChange={(event) => onSearchChange(event.target.value)} onKeyDown={onSearchKeyDown} placeholder="搜索标题、模型或消息" aria-label="搜索本地会话" /> : null}
        {searchOpen && searchLoading ? <small className="session-search-status" role="status">正在搜索…</small> : null}
        {searchError ? <div className="session-search-error" role="alert"><span>{searchError}</span><button type="button" onClick={onRetrySearch}>重试</button></div> : null}
      </div>

      <div className="session-list" aria-label="本地会话列表">
        {conversations.length === 0 && searchLoading && !searchOpen ? <p className="session-empty" role="status">正在加载本地会话…</p> : null}
        {conversations.length === 0 && !searchLoading && !searchError ? <p className="session-empty">{searchOpen && search ? "没有找到匹配的会话" : "还没有保存的会话"}</p> : conversations.map((conversation) => (
          <div
            className={`session-item ${conversation.id === selectedConversationId ? "selected" : ""}`}
            key={conversation.id}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openMenu(conversation, { x: event.clientX, y: event.clientY }, event.currentTarget.querySelector<HTMLElement>(".session-more-button") ?? event.currentTarget);
            }}
          >
            <button className="session-main" onClick={() => onSelectConversation(conversation)} disabled={disabled || loadingConversation}>
              <strong title={conversation.title}>{conversation.title}</strong>
              <small title={`${modelAliasFor(modelAliases, conversation.model, conversation.modelAlias)} · ${conversation.messageCount} 条 · ${displayTime(conversation.updatedAt)}`}>{modelAliasFor(modelAliases, conversation.model, conversation.modelAlias)} · {conversation.messageCount} 条 · {displayTime(conversation.updatedAt)}</small>
            </button>
            <button
              type="button"
              className="session-more-button"
              aria-label={`会话操作：${conversation.title}`}
              aria-haspopup="menu"
              onClick={(event) => {
                restoreMenuFocusRef.current = true;
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(conversation, { x: rect.right, y: rect.bottom }, event.currentTarget);
              }}
              disabled={disabled || loadingConversation}
            >⋯</button>
          </div>
        ))}
      </div>

      <div className="sidebar-bottom">
        <button className="ghost-button warm-button" onClick={onWarmup} disabled={!selectedModel || warming || disabled}>
          {warming ? "预热中…" : "常驻"}
        </button>
        <button className="ghost-button" onClick={onOpenSettings} disabled={disabled}>设置</button>
      </div>

      {menu ? <MenuSurface anchor={menu.anchor} onClose={closeMenu} className="session-context-menu" restoreFocusRef={menuTriggerRef} shouldRestoreFocus={() => restoreMenuFocusRef.current}>
        <button type="button" role="menuitem" disabled={disabled || loadingConversation} onClick={() => { restoreMenuFocusRef.current = false; runMenuAction(() => onRenameConversation(menu.conversation)); }}>重命名</button>
        <button type="button" role="menuitem" disabled={disabled || loadingConversation} onClick={() => { restoreMenuFocusRef.current = false; runMenuAction(() => onExportConversation(menu.conversation, "markdown")); }}>导出 Markdown</button>
        <button type="button" role="menuitem" disabled={disabled || loadingConversation} onClick={() => { restoreMenuFocusRef.current = false; runMenuAction(() => onExportConversation(menu.conversation, "json")); }}>导出 JSON</button>
        <button type="button" role="menuitem" disabled={disabled || loadingConversation} onClick={() => { restoreMenuFocusRef.current = false; runMenuAction(() => onDeleteConversation(menu.conversation)); }}>删除会话</button>
      </MenuSurface> : null}
    </aside>
  );
});

export default SessionSidebar;
