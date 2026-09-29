import { describe, expect, it } from "vitest";
import { shouldKeepConversationAfterStartFailure } from "./session";

describe("initial conversation failure state", () => {
  it("keeps an existing conversation when a later request fails", () => {
    expect(shouldKeepConversationAfterStartFailure(true, false)).toBe(true);
  });

  it("keeps a newly created conversation when its first chat call fails", () => {
    expect(shouldKeepConversationAfterStartFailure(false, true)).toBe(true);
  });

  it("resets only when the first conversation was never persisted", () => {
    expect(shouldKeepConversationAfterStartFailure(false, false)).toBe(false);
  });
});
