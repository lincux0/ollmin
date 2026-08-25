export interface FrameScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export interface StreamEnqueueOptions {
  /** Flush terminal/error/cancel snapshots synchronously. */
  terminal?: boolean;
  /** Flush the first non-empty thinking/content snapshot synchronously. */
  hasVisibleDelta?: boolean;
  immediate?: boolean;
}

export interface StreamCoalescer<T> {
  enqueue(value: T, options?: StreamEnqueueOptions): void;
  flush(): void;
  dispose(): void;
}

function defaultScheduler(): FrameScheduler {
  const requestFrame = typeof globalThis.requestAnimationFrame === "function"
    ? (callback: () => void) => globalThis.requestAnimationFrame(callback)
    : (callback: () => void) => globalThis.setTimeout(callback, 16);
  const cancelFrame = typeof globalThis.cancelAnimationFrame === "function"
    ? (handle: number) => globalThis.cancelAnimationFrame(handle)
    : (handle: number) => globalThis.clearTimeout(handle);
  return {
    requestFrame,
    cancelFrame,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
}

/**
 * Coalesces incremental stream snapshots into at most one React update per
 * animation frame while keeping the first visible and terminal snapshots fast.
 */
export function createStreamCoalescer<T>(
  onFlush: (value: T) => void,
  scheduler: FrameScheduler = defaultScheduler(),
  maxWaitMs = 32,
): StreamCoalescer<T> {
  let pending: T | undefined;
  let frameHandle: number | null = null;
  let timeoutHandle: number | null = null;
  let disposed = false;
  let flushedOnce = false;

  const clearScheduled = () => {
    if (frameHandle !== null) {
      scheduler.cancelFrame(frameHandle);
      frameHandle = null;
    }
    if (timeoutHandle !== null) {
      scheduler.clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const flush = () => {
    if (disposed || pending === undefined) return;
    const value = pending;
    pending = undefined;
    clearScheduled();
    flushedOnce = true;
    onFlush(value);
  };

  const schedule = () => {
    if (frameHandle !== null || disposed) return;
    frameHandle = scheduler.requestFrame(flush);
    timeoutHandle = scheduler.setTimeout(flush, maxWaitMs);
  };

  return {
    enqueue(value, options = {}) {
      if (disposed) return;
      pending = value;
      if (options.immediate || options.terminal || (!flushedOnce && options.hasVisibleDelta)) {
        flush();
      } else {
        schedule();
      }
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = undefined;
      clearScheduled();
    },
  };
}
