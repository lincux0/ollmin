import { describe, expect, it } from "vitest";
import { chatWidth } from "./ChatWorkspace";

describe("正文共享轴", () => {
  it("自适应并在窄窗限制为可用宽度，手动宽度不改变窗口约束", () => {
    expect(chatWidth(900, null)).toBe(680);
    expect(chatWidth(1440, null)).toBe(920);
    expect(chatWidth(600, null)).toBe(560);
    expect(chatWidth(900, 1000)).toBe(860);
    expect(chatWidth(1440, 800)).toBe(800);
  });
});
