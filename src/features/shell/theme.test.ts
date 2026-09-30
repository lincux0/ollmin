import { describe, expect, it, vi } from "vitest";
import { applyThemePreference } from "./theme";

describe("applyThemePreference", () => {
  it("tracks and releases system theme changes", () => {
    const root = { dataset: {} as DOMStringMap };
    const listeners = new Set<EventListener>();
    let matches = false;
    const preference = {
      get matches() { return matches; },
      addEventListener: vi.fn((_type: string, listener: EventListener) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: EventListener) => listeners.delete(listener)),
    };

    const cleanup = applyThemePreference("system", root, preference);
    expect(root.dataset.theme).toBe("light");
    matches = true;
    for (const listener of listeners) listener(new Event("change"));
    expect(root.dataset.theme).toBe("dark");
    cleanup?.();

    expect(preference.removeEventListener).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it("does not subscribe when the user selected a fixed theme", () => {
    const root = { dataset: {} as DOMStringMap };
    const preference = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const cleanup = applyThemePreference("light", root, preference);

    expect(root.dataset.theme).toBe("light");
    expect(preference.addEventListener).not.toHaveBeenCalled();
    expect(cleanup).toBeUndefined();
  });
});
