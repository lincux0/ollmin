import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { pushOverlay, topOverlay } from "./overlayStack";

export interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  labelledBy: string;
  className?: string;
  backdropClassName?: string;
}

export default function Modal({ children, onClose, labelledBy, className = "", backdropClassName = "modal-backdrop" }: ModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!previousFocusRef.current) previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const popOverlay = pushOverlay(dialog);

    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ));
    (focusables()[0] ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (topOverlay() !== dialog || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
      } else if (event.key === "Tab") {
        const items = focusables();
        if (items.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const keepFocusInside = (event: FocusEvent) => {
      if (topOverlay() === dialog && !dialog.contains(event.target as Node)) {
        (focusables()[0] ?? dialog).focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", keepFocusInside);
      popOverlay();
      const target = previousFocusRef.current;
      // Wait for simultaneous nested dismissals before restoring outside focus.
      requestAnimationFrame(() => {
        const top = topOverlay();
        if (target?.isConnected && target.getClientRects().length && (!top || top.contains(target))) target.focus();
        else if (document.activeElement === document.body || !(document.activeElement instanceof HTMLElement) || !document.activeElement.getClientRects().length || (top && !top.contains(document.activeElement))) {
          const fallback = Array.from((top ?? document).querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).find(element => element.getClientRects().length > 0);
          fallback?.focus();
        }
      });
    };
  }, []);

  return createPortal(
    <div
      className={backdropClassName}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section ref={dialogRef} className={className} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
        {children}
      </section>
    </div>,
    document.body,
  );
}
