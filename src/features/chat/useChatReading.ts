import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** 只导航已加载消息，不读取分页或触发生成。 */
export function useChatReading(listRef: RefObject<HTMLDivElement | null>, contentRef: RefObject<HTMLDivElement | null>, followRef: RefObject<boolean>, messages: readonly { id: string; role: string }[], conversationId: string | null) {
  const [away, setAway] = useState(false);
  const [currentTurn, setCurrentTurn] = useState<string | null>(null);
  const anchor = useRef<{ element: HTMLElement; offset: number } | null>(null);
  const measure = useCallback((userScroll: boolean) => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content) return;
    if (userScroll) followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 72;
    setAway(!followRef.current);
    const top = list.getBoundingClientRect().top;
    let first: HTMLElement | null = null;
    let turn: string | null = null;
    for (const child of content.children) {
      if (!(child instanceof HTMLElement)) continue;
      const rect = child.getBoundingClientRect();
      if (!first && rect.bottom > top) first = child;
      if (child.dataset.role === "user" && (turn === null || rect.top <= top + 24)) turn = child.dataset.messageId ?? null;
      if (rect.top > top + list.clientHeight && first) break;
    }
    if (first) anchor.current = { element: first, offset: first.getBoundingClientRect().top - top };
    setCurrentTurn(turn);
  }, [contentRef, followRef, listRef]);
  const restore = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    if (followRef.current) list.scrollTop = list.scrollHeight;
    else if (anchor.current?.element.isConnected) {
      list.scrollTop += anchor.current.element.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.current.offset;
    }
    measure(false);
  }, [followRef, listRef, measure]);
  useLayoutEffect(() => {
    anchor.current = null;
    followRef.current = true;
    setAway(false);
    setCurrentTurn(null);
  }, [conversationId, followRef]);
  useLayoutEffect(restore, [messages, restore]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(restore);
    if (listRef.current) observer.observe(listRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [contentRef, listRef, restore]);
  const onScroll = useCallback(() => measure(true), [measure]);
  const jumpToTurn = (id: string) => {
    const list = listRef.current;
    const target = Array.from(contentRef.current?.children ?? []).find(element => (element as HTMLElement).dataset.messageId === id);
    if (!list || !target) return;
    followRef.current = false;
    list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - 12;
    measure(false);
  };
  const jumpToLatest = () => { followRef.current = true; restore(); };
  return { away, currentTurn, onScroll, jumpToTurn, jumpToLatest };
}
