import { useEffect, useState, type MouseEvent } from "react";
import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import Icon from "./Icon";

export function watchMaximized(
  appWindow: Pick<TauriWindow, "isMaximized" | "onResized">,
  onChange: (maximized: boolean) => void,
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let latestRead = 0;

  const update = async () => {
    const read = ++latestRead;
    try {
      const maximized = await appWindow.isMaximized();
      if (!disposed && read === latestRead) onChange(maximized);
    } catch {
      // Browser previews and window teardown may reject Tauri window calls.
    }
  };

  void appWindow.onResized(() => { void update(); }).then((cleanup) => {
    if (disposed) cleanup();
    else unlisten = cleanup;
  }).catch(() => undefined);
  void update();

  return () => {
    disposed = true;
    unlisten?.();
  };
}

export type WindowTitleBarProps = {
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
  onNewChat?: () => void;
  onSearch?: () => void;
  newChatDisabled?: boolean;
};

export default function WindowTitleBar({ onToggleSidebar, sidebarCollapsed = false, onNewChat, onSearch, newChatDisabled = false }: WindowTitleBarProps = {}) {
  const [maximized, setMaximized] = useState(false);
  const [appWindow] = useState<TauriWindow | null>(() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  });

  useEffect(() => {
    return appWindow ? watchMaximized(appWindow, setMaximized) : undefined;
  }, [appWindow]);

  const ignoreDrag = (event: MouseEvent<HTMLButtonElement>) => event.stopPropagation();
  const toggleMaximize = () => { void appWindow?.toggleMaximize().catch(() => undefined); };

  return (
    <header className="window-bar">
      {(onToggleSidebar || onNewChat || onSearch) && (
        <div className="window-leading-actions" aria-label="应用操作">
          {onToggleSidebar && <button type="button" className="window-action" title={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"} aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"} onMouseDown={ignoreDrag} onClick={onToggleSidebar}><Icon name="sidebar" size={17} /></button>}
          {onNewChat && <button type="button" className="window-action" title="新建对话" aria-label="新建对话" disabled={newChatDisabled} onMouseDown={ignoreDrag} onClick={onNewChat}><Icon name="plus" size={17} /></button>}
          {onSearch && <button type="button" className="window-action" title="搜索会话（Ctrl+K）" aria-label="搜索会话" onMouseDown={ignoreDrag} onClick={onSearch}><Icon name="search" size={17} /></button>}
        </div>
      )}
      <div
        className="window-drag-region"
        data-tauri-drag-region
        onMouseDown={(event) => {
          if (event.button === 0) void appWindow?.startDragging().catch(() => undefined);
        }}
        onDoubleClick={toggleMaximize}
      >
        <span className="window-brand-mark">O</span>
        <strong>Ollmin</strong>
        <span>本地 Ollama</span>
      </div>
      <div className="window-controls" aria-label="窗口控制">
        <button type="button" className="window-control" title="最小化" aria-label="最小化" onMouseDown={ignoreDrag} onClick={() => { void appWindow?.minimize().catch(() => undefined); }}><Icon name="minimize" size={15} /></button>
        <button type="button" className="window-control" title={maximized ? "还原" : "最大化"} aria-label={maximized ? "还原" : "最大化"} onMouseDown={ignoreDrag} onClick={toggleMaximize}><Icon name={maximized ? "restore" : "maximize"} size={14} /></button>
        <button type="button" className="window-control close" title="关闭" aria-label="关闭" onMouseDown={ignoreDrag} onClick={() => { void appWindow?.close().catch(() => undefined); }}><Icon name="close" size={16} /></button>
      </div>
    </header>
  );
}
