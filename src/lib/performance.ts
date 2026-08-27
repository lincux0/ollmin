import type { ChatMessage } from "../types";

export type PerformanceMode = "fast" | "balanced" | "reasoning";

export type ContextSize = 4096 | 8192 | 16384;
export type OutputTokenLimit = 1024 | 2048 | 4096;

export const DEFAULT_CONTEXT_SIZE: ContextSize = 4096;
export const CONTEXT_SIZE_OPTIONS: readonly ContextSize[] = [4096, 8192, 16384];
export const DEFAULT_OUTPUT_TOKEN_LIMIT: OutputTokenLimit = 2048;
export const OUTPUT_TOKEN_LIMIT_OPTIONS: readonly OutputTokenLimit[] = [1024, 2048, 4096];

export interface PerformanceProfile {
  mode: PerformanceMode;
  label: string;
  description: string;
  think: boolean;
  numCtx: number;
  numPredict: number;
  maxHistoryTokens: number;
}
/**
 * Fast mode is intentionally conservative: no reasoning, a bounded context,
 * and a bounded output budget. These values are part of the request contract so
 * a future chat screen cannot silently fall back to an expensive profile.
 */
export const PERFORMANCE_PROFILES: Record<PerformanceMode, PerformanceProfile> = {
  fast: {
    mode: "fast",
    label: "快速",
    description: "关闭思考，最多保留约 2048 个历史 token",
    think: false,
    numCtx: 4096,
    numPredict: 2048,
    maxHistoryTokens: 2048,
  },
  balanced: {
    mode: "balanced",
    label: "平衡",
    description: "允许思考，保留较长历史",
    think: true,
    numCtx: 4096,
    numPredict: 768,
    maxHistoryTokens: 3072,
  },
  reasoning: {
    mode: "reasoning",
    label: "推理",
    description: "允许思考和更长输出，等待时间更长",
    think: true,
    numCtx: 8192,
    numPredict: 2048,
    maxHistoryTokens: 6144,
  },
};

export function profileForMode(mode: PerformanceMode): PerformanceProfile {
  return PERFORMANCE_PROFILES[mode];
}

export function estimateMessageTokens(message: ChatMessage): number {
  // This is deliberately a conservative UI-side estimate. Ollama's final
  // prompt_eval_count remains the authoritative measurement.
  return Math.max(1, Math.ceil(message.content.length / 3.5) + 4);
}
