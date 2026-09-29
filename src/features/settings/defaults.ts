import type { AppSettings } from "../../contracts/ipc";
import {
  DEFAULT_CONTEXT_SIZE,
  DEFAULT_OUTPUT_TOKEN_LIMIT,
  DEFAULT_REASONING_TOKEN_LIMIT,
} from "../../lib/performance";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  saveThinking: false,
  defaultMode: "fast",
  defaultModel: "",
  modelAliases: {},
  contextSize: DEFAULT_CONTEXT_SIZE,
  outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  reasoningTokenLimit: DEFAULT_REASONING_TOKEN_LIMIT,
};
