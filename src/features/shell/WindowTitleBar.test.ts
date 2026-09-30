import { describe, expect, it, vi } from "vitest";
import { watchMaximized } from "./WindowTitleBar";

describe("watchMaximized", () => {
  it("unlistens when registration resolves after cleanup", async () => {
    let register: ((cleanup: () => void) => void) | undefined;
    const unlisten = vi.fn();
    const appWindow = {
      isMaximized: vi.fn().mockResolvedValue(false),
      onResized: vi.fn(() => new Promise<() => void>((resolve) => { register = resolve; })),
    };

    const dispose = watchMaximized(appWindow as Parameters<typeof watchMaximized>[0], vi.fn());
    dispose();
    register?.(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("updates maximized state after resize events", async () => {
    let resized: (() => void) | undefined;
    let maximized = false;
    const onChange = vi.fn();
    const appWindow = {
      isMaximized: vi.fn(async () => maximized),
      onResized: vi.fn(async (handler: () => void) => { resized = handler; return vi.fn(); }),
    };

    const dispose = watchMaximized(appWindow as Parameters<typeof watchMaximized>[0], onChange);
    await Promise.resolve();
    await Promise.resolve();
    onChange.mockClear();
    maximized = true;
    resized?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onChange).toHaveBeenLastCalledWith(true);
    dispose();
  });

  it("ignores a stale maximized-state read", async () => {
    let resized: (() => void) | undefined;
    const resolveReads: Array<(maximized: boolean) => void> = [];
    const onChange = vi.fn();
    const appWindow = {
      isMaximized: vi.fn(() => new Promise<boolean>((resolve) => resolveReads.push(resolve))),
      onResized: vi.fn(async (handler: () => void) => { resized = handler; return vi.fn(); }),
    };

    const dispose = watchMaximized(appWindow as Parameters<typeof watchMaximized>[0], onChange);
    await Promise.resolve();
    resized?.();
    resolveReads[1]?.(true);
    await Promise.resolve();
    resolveReads[0]?.(false);
    await Promise.resolve();

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith(true);
    dispose();
  });
});
