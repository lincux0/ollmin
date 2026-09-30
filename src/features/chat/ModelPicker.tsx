import { useLayoutEffect, useMemo, useRef, useState } from "react";
import MenuSurface, { type MenuAnchor } from "../../components/ui/MenuSurface";
import { topOverlay } from "../../components/ui/overlayStack";
import { modelAliasFor } from "../models/helpers";
import { PERFORMANCE_PROFILES, type PerformanceMode } from "../../lib/performance";

export type ModelPickerKind = "combined" | "model" | "mode";

export interface ModelPickerProps {
  models: string[];
  selectedModel: string;
  modelAliases: Record<string, string>;
  currentModelAlias: string;
  mode: PerformanceMode;
  busy: boolean;
  modelLocked: boolean;
  loadingModels: boolean;
  modelsError: string | null;
  onRetryModels: () => void;
  onSelectModel: (model: string) => void;
  onSelectMode: (mode: PerformanceMode) => void;
  kind?: ModelPickerKind;
}

type MenuPage = "root" | "models" | "performance";

export function filterModels(models: string[], aliases: Record<string, string>, query: string, selectedModel: string, currentModelAlias: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return models.filter((name) => {
    if (!normalized) return true;
    const alias = modelAliasFor(aliases, name, name === selectedModel ? currentModelAlias : undefined);
    return alias.toLocaleLowerCase().includes(normalized) || name.toLocaleLowerCase().includes(normalized);
  });
}

export default function ModelPicker({
  models, selectedModel, modelAliases, currentModelAlias, mode, busy, modelLocked,
  loadingModels, modelsError, onRetryModels, onSelectModel, onSelectMode, kind = "combined",
}: ModelPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootModelRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [page, setPage] = useState<MenuPage>("root");
  const [query, setQuery] = useState("");
  const isOpen = anchor !== null;
  const showSearch = models.length > 4;
  const visibleModels = useMemo(
    () => filterModels(models, modelAliases, query, selectedModel, currentModelAlias),
    [models, modelAliases, query, selectedModel, currentModelAlias],
  );

  useLayoutEffect(() => {
    if (isOpen && page === "models" && showSearch) searchRef.current?.focus();
    else if (isOpen) topOverlay()?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [isOpen, page, showSearch, kind]);

  const open = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setQuery("");
    setPage(kind === "mode" ? "performance" : kind === "model" ? "models" : "root");
    setAnchor({ x: rect.left, y: rect.bottom });
  };

  const close = () => setAnchor(null);
  const handleMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (kind === "combined" && page !== "root") setPage("root");
      else close();
      return true;
    }
    if (page === "models" && event.target === searchRef.current && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const items = Array.from(topOverlay()?.querySelectorAll<HTMLButtonElement>("[data-model-option]:not(:disabled), [data-model-retry]:not(:disabled)") ?? []);
      items[event.key === "ArrowDown" ? 0 : items.length - 1]?.focus();
      return true;
    }
    return false;
  };

  const aliasFor = (name: string) => modelAliasFor(modelAliases, name, name === selectedModel ? currentModelAlias : undefined);
  const selectModel = (name: string) => { onSelectModel(name); close(); };
  const selectMode = (nextMode: PerformanceMode) => { onSelectMode(nextMode); close(); };
  const modelLockedHere = busy || modelLocked;
  const activeMode = PERFORMANCE_PROFILES[mode];

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`model-picker-trigger model-picker-trigger-${kind}`}
      aria-label={kind === "mode" ? `性能模式：${activeMode.label}` : kind === "model" ? `模型：${selectedModel ? aliasFor(selectedModel) : "选择模型"}` : `模型与性能：${selectedModel ? aliasFor(selectedModel) : "选择模型"}，${activeMode.label}`}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      onClick={open}
      disabled={busy || (kind === "model" && modelLocked)}
    >
      {kind === "mode" ? activeMode.label : <><span className="model-picker-name" title={selectedModel ? aliasFor(selectedModel) : undefined}>{selectedModel ? aliasFor(selectedModel) : "选择模型"}</span>{kind === "combined" ? <span className="model-picker-mode">{activeMode.label}</span> : null}</>}
    </button>
    {anchor ? <MenuSurface
      anchor={anchor}
      onClose={close}
      className="model-picker-menu"
      restoreFocusRef={triggerRef}
      onKeyDown={handleMenuKeyDown}
      style={{ width: "min(280px, calc(100vw - 32px))", minWidth: "min(240px, calc(100vw - 32px))", maxHeight: "min(360px, calc(100dvh - 32px))" }}
    >
      {page === "root" ? <>
        <button ref={rootModelRef} type="button" role="menuitem" disabled={modelLockedHere} onClick={() => setPage("models")}><span>模型</span><span className="model-picker-value">{selectedModel ? aliasFor(selectedModel) : "未选择"}　›</span></button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => setPage("performance")}><span>性能</span><span className="model-picker-value">{activeMode.label}　›</span></button>
      </> : null}

      {page === "models" ? <>
        {kind === "combined" ? <button type="button" role="menuitem" onClick={() => setPage("root")}>‹　返回</button> : null}
        {showSearch ? <input ref={searchRef} className="model-picker-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型名称或别名" aria-label="搜索模型名称或别名" /> : null}
        {loadingModels ? <div className="model-picker-status" role="status">正在加载本机模型…</div> : null}
        {!loadingModels && modelsError ? <div className="model-picker-error" role="alert"><span>{modelsError}</span><button type="button" role="menuitem" data-model-retry onClick={onRetryModels}>重试</button></div> : null}
        {!loadingModels && !modelsError && models.length === 0 ? <div className="model-picker-status" tabIndex={-1}>没有检测到本机模型</div> : null}
        {!loadingModels && !modelsError && models.length > 0 && visibleModels.length === 0 ? <div className="model-picker-status">没有匹配的模型</div> : null}
        {!loadingModels && !modelsError ? visibleModels.map((name) => <button
          key={name}
          type="button"
          role="menuitem"
          data-model-option
          disabled={modelLockedHere}
          aria-current={name === selectedModel ? "true" : undefined}
          onClick={() => selectModel(name)}
        ><span className="model-picker-name" title={aliasFor(name)}>{aliasFor(name)}</span>{name === selectedModel ? <span className="model-picker-value">✓</span> : null}</button>) : null}
      </> : null}

      {page === "performance" ? <>
        {kind === "combined" ? <button type="button" role="menuitem" onClick={() => setPage("root")}>‹　返回</button> : null}
        {(Object.values(PERFORMANCE_PROFILES)).map((profile) => <button
          key={profile.mode}
          type="button"
          role="menuitem"
          aria-current={profile.mode === mode ? "true" : undefined}
          disabled={busy}
          onClick={() => selectMode(profile.mode)}
        ><span>{profile.label}</span><span className="model-picker-value">{profile.mode === mode ? "✓" : profile.description}</span></button>)}
      </> : null}
    </MenuSurface> : null}
  </>;
}
