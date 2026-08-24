import { describe, expect, it } from "vitest";
import { trimHistoryForFastMode } from "./history";
import type { ChatMessage } from "../types";

const message = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

describe("fast-mode history trimming", () => {
  it("keeps system and latest user messages while dropping old complete turns", () => {
    const history = [
      message("system", "You are concise."),
      message("user", "old question".repeat(40)),
      message("assistant", "old answer".repeat(40)),
      message("user", "recent question"),
      message("assistant", "recent answer"),
      message("user", "current question"),
    ];

    const result = trimHistoryForFastMode(history, 80);

    expect(result.messages[0]).toEqual(history[0]);
    expect(result.messages.at(-1)).toEqual(history.at(-1));
    expect(result.messages.some((item) => item.content === "old question".repeat(40))).toBe(false);
    expect(result.messages.some((item) => item.content === "recent question")).toBe(true);
    expect(result.droppedMessages).toBeGreaterThan(0);
  });

  it("does not keep an orphan assistant message when a turn is over budget", () => {
    const history = [
      message("user", "old question".repeat(40)),
      message("assistant", "old answer".repeat(40)),
      message("user", "current question"),
    ];

    const result = trimHistoryForFastMode(history, 40);

    expect(result.messages.map((item) => item.content)).toEqual(["current question"]);
  });
});
