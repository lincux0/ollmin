import { describe, expect, it } from "vitest";
import { DEFAULT_UI_FONT_SIZE, readUiFontSize, writeUiFontSize } from "./uiFontSize";

describe("界面字号偏好", () => {
  it("只读取 12–22 的整数，否则回退到 14", () => {
    const original = globalThis.localStorage;
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
    try {
      expect(readUiFontSize()).toBe(DEFAULT_UI_FONT_SIZE);
      values.set("ollmin.uiFontSize", "22");
      expect(readUiFontSize()).toBe(22);
      values.set("ollmin.uiFontSize", "22.5");
      expect(readUiFontSize()).toBe(DEFAULT_UI_FONT_SIZE);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
    }
  });

  it("存储失败时抛出错误供设置界面显示", () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: () => { throw new Error("quota"); } } });
    try { expect(() => writeUiFontSize(16)).toThrow("quota"); }
    finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original }); }
  });
});
