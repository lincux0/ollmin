import { describe, expect, it } from "vitest";
import { messageStatus, newId, safeMode, toChatMessage } from "./helpers";
import type { ConversationMessage } from "./types";

describe("chat feature helpers", () => {
  it("preserves the chat payload shape while omitting empty thinking", () => {
    const message: ConversationMessage = {
      id: "message-1",
      role: "user",
      content: "请总结这份文件",
      thinking: "",
      status: "done",
    };
    expect(toChatMessage(message)).toEqual({
      role: "user",
      content: "请总结这份文件",
    });
  });

  it("normalizes persisted statuses and unknown performance modes", () => {
    expect(messageStatus("streaming")).toBe("streaming");
    expect(messageStatus("unexpected")).toBe("done");
    expect(safeMode("reasoning")).toBe("reasoning");
    expect(safeMode("unexpected")).toBe("fast");
  });

  it("generates a namespaced request id", () => {
    expect(newId("chat")).toMatch(/^chat-.+/);
  });
});
