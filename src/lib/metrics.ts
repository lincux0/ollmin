import type { ChatMetrics, ChatResponse } from "../types";

export function nanosToMs(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value / 1_000_000;
}
export function nanosToSeconds(value: number | undefined): number | null {
  const milliseconds = nanosToMs(value);
  return milliseconds === null ? null : milliseconds / 1000;
}

export function deriveChatMetrics(response: ChatResponse, wallMs: number): ChatMetrics {
  const outputTokens = response.eval_count ?? null;
  const evalSeconds = nanosToSeconds(response.eval_duration);

  return {
    wallMs,
    totalMs: nanosToMs(response.total_duration),
    loadMs: nanosToMs(response.load_duration),
    promptMs: nanosToMs(response.prompt_eval_duration),
    evalMs: nanosToMs(response.eval_duration),
    promptTokens: response.prompt_eval_count ?? null,
    outputTokens,
    outputTokensPerSecond:
      outputTokens !== null && evalSeconds !== null && evalSeconds > 0
        ? outputTokens / evalSeconds
        : null,
    thinkingCharacters: response.message?.thinking?.length ?? 0,
  };
}

export function formatMetric(value: number | null, digits = 0): string {
  return value === null ? "—" : value.toFixed(digits);
}
