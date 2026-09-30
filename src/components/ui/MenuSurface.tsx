import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { pushOverlay, topOverlay } from "./overlayStack";

export interface MenuAnchor {
  x: number;
  y: number;
}

export interface MenuSurfaceProps {
  anchor: MenuAnchor;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  shouldRestoreFocus?: () => boolean;
  onKeyDown?: (event: KeyboardEvent) => boolean;
}

export function placeMenu(anchor: MenuAnchor, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const margin = 8;
  return {
    left: Math.max(margin, Math.min(anchor.x + width > viewportWidth - margin ? anchor.x - width : anchor.x, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(anchor.y + height > viewportHeight - margin ? anchor.y - height : anchor.y, viewportHeight - height - margin)),
  };
}

export default function MenuSurface({ anchor, children, onClose, className = "", style, restoreFocusRef, shouldRestoreFocus, onKeyDown }: MenuSurfaceProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const shouldRestoreFocusRef = useRef(shouldRestoreFocus);
  const onKeyDownRef = useRef(onKeyDown);
  const [position, setPosition] = useState({ left: -10000, top: -10000 });
  onCloseRef.current = onClose;
  shouldRestoreFocusRef.current = shouldRestoreFocus;
  onKeyDownRef.current = onKeyDown;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const update = () => setPosition(placeMenu(anchor, menu.offsetWidth, menu.offsetHeight, window.innerWidth, window.innerHeight));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(menu);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = menuRef.current;
    if (!menu) return;
    const popOverlay = pushOverlay(menu);
    const focusables = () => Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    (focusables()[0] ?? menu.querySelector<HTMLElement>("input:not(:disabled), [tabindex='-1']"))?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node)) onCloseRef.current();
    };
    const onBlur = () => onCloseRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (topOverlay() !== menu) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)) return;
      if (onKeyDownRef.current?.(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName) && ["Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      const items = focusables();
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        items[event.key === "Home" ? 0 : items.length - 1].focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      popOverlay();
      if (shouldRestoreFocusRef.current?.() === false) return;
      const target = restoreFocusRef?.current ?? previousFocusRef.current;
      if (target?.isConnected) target.focus();
    };
  }, [restoreFocusRef]);

  return createPortal(
    <div ref={menuRef} className={`menu-surface ${className}`.trim()} role="menu" style={{ ...style, position: "fixed", left: position.left, top: position.top }}>
      {children}
    </div>,
    document.body,
  );
}
