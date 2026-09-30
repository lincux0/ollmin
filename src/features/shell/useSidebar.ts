import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  clampSidebarWidth,
  isSidebarNarrow,
  loadSidebarPreferences,
  saveSidebarCollapsed,
  saveSidebarWidth,
  type StorageLike,
} from "./sidebar";

function getStorage(): StorageLike | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

function getViewportWidth(): number {
  return typeof window === "undefined" ? 1280 : window.innerWidth;
}

export function useSidebar() {
  const [preferences, setPreferences] = useState(() => loadSidebarPreferences(getStorage()));
  const [narrow, setNarrow] = useState(() => isSidebarNarrow(getViewportWidth()));
  const [narrowExpanded, setNarrowExpanded] = useState<boolean | null>(null);
  const [width, setWidth] = useState(preferences.width);
  const [animating, setAnimating] = useState(false);
  const animationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animate = useCallback(() => {
    if (animationTimer.current !== null) clearTimeout(animationTimer.current);
    setAnimating(true);
    animationTimer.current = setTimeout(() => setAnimating(false), 180);
  }, []);
  const collapsed = narrow
    ? narrowExpanded === null ? true : !narrowExpanded
    : preferences.collapsed;
  const storage = useRef<StorageLike | undefined>(getStorage());
  const pointerId = useRef<number | null>(null);
  const pendingWidth = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const onResize = () => {
      setAnimating(false);
      const isNarrow = isSidebarNarrow(window.innerWidth);
      setNarrow(isNarrow);
      if (!isNarrow) setNarrowExpanded(null);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (animationTimer.current !== null) clearTimeout(animationTimer.current);
  }, []);

  const toggle = useCallback(() => {
    animate();
    if (narrow) setNarrowExpanded(collapsed);
    else {
      const next = !preferences.collapsed;
      setPreferences((current) => ({ ...current, collapsed: next }));
      saveSidebarCollapsed(storage.current, next);
    }
  }, [animate, collapsed, narrow, preferences.collapsed]);

  const expand = useCallback(() => {
    if (collapsed) animate();
    if (narrow) setNarrowExpanded(true);
    else {
      setPreferences((current) => ({ ...current, collapsed: false }));
      saveSidebarCollapsed(storage.current, false);
    }
  }, [animate, collapsed, narrow]);

  const commitWidth = useCallback((next: number) => {
    const safeWidth = clampSidebarWidth(next);
    setWidth(safeWidth);
    setPreferences((current) => ({ ...current, width: safeWidth }));
    saveSidebarWidth(storage.current, safeWidth);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setAnimating(false);
    pointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (pointerId.current !== event.pointerId) return;
    pendingWidth.current = clampSidebarWidth(event.clientX);
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (pendingWidth.current !== null) setWidth(pendingWidth.current);
      });
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    const finalWidth = event.clientX;
    pendingWidth.current = null;
    commitWidth(finalWidth);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onPointerCancel = (event: PointerEvent<HTMLElement>) => {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    pendingWidth.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setWidth(preferences.width);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 24 : 8;
    const next = event.key === "ArrowLeft" ? width - step
      : event.key === "ArrowRight" ? width + step
        : event.key === "Home" ? 264
          : event.key === "End" ? 420 : null;
    if (next === null) return;
    event.preventDefault();
    commitWidth(next);
  };

  return {
    width,
    collapsed,
    animating,
    toggle,
    expand,
    resizeProps: {
      role: "separator" as const,
      "aria-label": "调整侧栏宽度",
      "aria-orientation": "vertical" as const,
      "aria-valuemin": 264,
      "aria-valuemax": 420,
      "aria-valuenow": width,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture: onPointerCancel,
      onKeyDown,
    },
  };
}
