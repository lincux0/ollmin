import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const WIDTH_KEY = "ollmin.ui.chatWidth";
export function chatWidth(column: number, preferred: number | null) {
  const available = Math.max(0, column - 40);
  return Math.min(available, preferred ?? Math.min(920, Math.max(680, column * 0.64)));
}

export default function ChatWorkspace({ children, stage = "active" }: { children: ReactNode; stage?: "hero" | "active" | "settling" }) {
  const panel = useRef<HTMLElement>(null);
  const [column, setColumn] = useState(0);
  const [preferred, setPreferred] = useState<number | null>(() => {
    try {
      const value = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(value) && value >= 640 ? value : null;
    } catch { return null; }
  });
  const pending = useRef<number | null>(null);
  const beforeDrag = useRef<number | null>(null);
  const dragging = useRef(false);
  const frame = useRef(0);
  const width = chatWidth(column, preferred);
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setColumn(element.clientWidth));
    observer.observe(element);
    setColumn(element.clientWidth);
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); };
  }, []);
  function save(value: number | null) {
    setPreferred(value);
    try {
      if (value === null) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(value));
    } catch { /* UI preferences must not block chatting. */ }
  }
  function cancelDrag() {
    if (!dragging.current) return;
    dragging.current = false;
    cancelAnimationFrame(frame.current); frame.current = 0; pending.current = null;
    setPreferred(beforeDrag.current);
  }
  return <section ref={panel} className={`conversation-panel workspace-${stage}`} data-turn-rail={column - width >= 104} aria-busy={stage === "settling"} style={{ "--chat-width": `${width}px` } as CSSProperties}>
    {children}
    <div className="chat-width-handle" role="separator" tabIndex={0} aria-label="正文宽度" aria-orientation="vertical" aria-valuemin={Math.min(640, Math.max(0, column - 40))} aria-valuemax={Math.max(0, column - 40)} aria-valuenow={Math.round(width)}
      onDoubleClick={() => save(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          save(Math.min(Math.max(640, width + (event.key === "ArrowRight" ? 32 : -32)), Math.max(640, column - 40)));
        } else if (event.key === "Home") { event.preventDefault(); save(null); }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        beforeDrag.current = preferred;
        dragging.current = true;
        pending.current = null;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId) || !panel.current) return;
        const bounds = panel.current.getBoundingClientRect();
        pending.current = Math.min(Math.max(640, (event.clientX - bounds.left - bounds.width / 2) * 2), Math.max(640, bounds.width - 40));
        if (!frame.current) frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          if (pending.current !== null) setPreferred(pending.current);
        });
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
        cancelAnimationFrame(frame.current); frame.current = 0;
        if (pending.current !== null) save(pending.current);
        pending.current = null;
      }}
      onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
      title="拖动调整正文宽度；双击或 Home 恢复自适应" />
  </section>;
}
