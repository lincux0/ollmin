import { describe, expect, it } from "vitest";
import { composerMaxHeight, shouldSubmitOnEnter } from "./composerHelpers";

describe("composer input guards", () => {
  const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, repeat: false };

  it("submits only a plain, non-repeating Enter outside IME composition", () => {
    expect(shouldSubmitOnEnter(enter, false)).toBe(true);
    expect(shouldSubmitOnEnter({ ...enter, shiftKey: true }, false)).toBe(false);
    expect(shouldSubmitOnEnter({ ...enter, isComposing: true }, false)).toBe(false);
    expect(shouldSubmitOnEnter({ ...enter, keyCode: 229 }, false)).toBe(false);
    expect(shouldSubmitOnEnter({ ...enter, repeat: true }, false)).toBe(false);
    expect(shouldSubmitOnEnter(enter, true)).toBe(false);
  });

  it("shrinks the textarea ceiling for short windows and caps it at 336px", () => {
    expect(composerMaxHeight(640)).toBe(256);
    expect(composerMaxHeight(400)).toBe(120);
    expect(composerMaxHeight(900)).toBe(336);
  });
});
