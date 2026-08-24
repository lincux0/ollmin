import { describe, expect, it } from "vitest";
import { deriveChatMetrics, nanosToMs } from "./metrics";

describe("chat metrics", () => {
  it("converts Ollama nanosecond fields and computes decode speed", () => {
    const metrics = deriveChatMetrics(
      {
        total_duration: 2_000_000_000,
        load_duration: 100_000_000,
        prompt_eval_duration: 400_000_000,
        eval_duration: 1_000_000_000,
        prompt_eval_count: 32,
        eval_count: 20,
        message: { role: "assistant", content: "ok", thinking: "plan" },
      },
      2100,
    );

    expect(metrics.totalMs).toBe(2000);
    expect(metrics.loadMs).toBe(100);
    expect(metrics.promptTokens).toBe(32);
    expect(metrics.outputTokensPerSecond).toBe(20);
    expect(metrics.thinkingCharacters).toBe(4);
  });

  it("returns null for absent or invalid durations", () => {
    expect(nanosToMs(undefined)).toBeNull();
    expect(nanosToMs(Number.NaN)).toBeNull();
  });
});
