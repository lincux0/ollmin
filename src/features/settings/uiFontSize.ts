export type UiFontSize = 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22;

export const DEFAULT_UI_FONT_SIZE: UiFontSize = 14;
const UI_FONT_SIZE_KEY = "ollmin.uiFontSize";

export function isUiFontSize(value: number): value is UiFontSize {
  return Number.isInteger(value) && value >= 12 && value <= 22;
}

export function readUiFontSize(): UiFontSize {
  try {
    const value = Number(globalThis.localStorage?.getItem(UI_FONT_SIZE_KEY));
    return isUiFontSize(value) ? value : DEFAULT_UI_FONT_SIZE;
  } catch {
    return DEFAULT_UI_FONT_SIZE;
  }
}

export function writeUiFontSize(value: UiFontSize): void {
  if (!isUiFontSize(value)) throw new RangeError("界面字号必须为 12–22 的整数。");
  globalThis.localStorage.setItem(UI_FONT_SIZE_KEY, String(value));
}
