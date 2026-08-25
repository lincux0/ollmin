import { describe, expect, it } from "vitest";
import { createStreamCoalescer, type FrameScheduler } from "./streaming";

function manualScheduler() {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler: FrameScheduler = {
    requestFrame(callback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    setTimeout(callback) {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
  };
  return {
    scheduler,
    runFrame() {
      const next = frames.entries().next().value as [number, () => void] | undefined;
      if (!next) return;
      frames.delete(next[0]);
      next[1]();
    },
    runTimer() {
      const next = timers.entries().next().value as [number, () => void] | undefined;
      if (!next) return;
      timers.delete(next[0]);
      next[1]();
    },
    frameCount: () => frames.size,
    timerCount: () => timers.size,
  };
}

describe("stream coalescer", () => {
  it("flushes the first visible snapshot immediately", () => {
    const scheduler = manualScheduler();
    const flushed: string[] = [];
    const coalescer = createStreamCoalescer((value: string) => flushed.push(value), scheduler.scheduler);

    coalescer.enqueue("first", { hasVisibleDelta: true });

    expect(flushed).toEqual(["first"]);
    expect(scheduler.frameCount()).toBe(0);
    expect(scheduler.timerCount()).toBe(0);
  });

  it("keeps only the newest cumulative snapshot within a frame", () => {
    const scheduler = manualScheduler();
    const flushed: string[] = [];
    const coalescer = createStreamCoalescer((value: string) => flushed.push(value), scheduler.scheduler);

    coalescer.enqueue("first", { hasVisibleDelta: true });
    coalescer.enqueue("first second");
    coalescer.enqueue("first second third");

    expect(flushed).toEqual(["first"]);
    expect(scheduler.frameCount()).toBe(1);
    scheduler.runFrame();
    expect(flushed).toEqual(["first", "first second third"]);
  });

  it("flushes a terminal snapshot without waiting for a frame", () => {
    const scheduler = manualScheduler();
    const flushed: string[] = [];
    const coalescer = createStreamCoalescer((value: string) => flushed.push(value), scheduler.scheduler);

    coalescer.enqueue("partial", { hasVisibleDelta: true });
    coalescer.enqueue("complete", { terminal: true });

    expect(flushed).toEqual(["partial", "complete"]);
    expect(scheduler.frameCount()).toBe(0);
    expect(scheduler.timerCount()).toBe(0);
  });

  it("does not deliver pending data after disposal", () => {
    const scheduler = manualScheduler();
    const flushed: string[] = [];
    const coalescer = createStreamCoalescer((value: string) => flushed.push(value), scheduler.scheduler);

    coalescer.enqueue("first", { hasVisibleDelta: true });
    coalescer.enqueue("pending");
    coalescer.dispose();
    scheduler.runFrame();
    scheduler.runTimer();

    expect(flushed).toEqual(["first"]);
  });
});
