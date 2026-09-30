import { describe, expect, it } from "vitest";
import { filterModels } from "./ModelPicker";

describe("filterModels", () => {
  it("matches either the configured alias or original Ollama name", () => {
    const models = ["qwen3:4b", "llama3.2:3b"];
    const aliases = { "qwen3:4b": "办公助手" };
    expect(filterModels(models, aliases, "办公", "", "")).toEqual(["qwen3:4b"]);
    expect(filterModels(models, aliases, "LLAMA3", "", "")).toEqual(["llama3.2:3b"]);
  });

  it("uses the current conversation alias when no configured alias exists", () => {
    expect(filterModels(["qwen3:4b"], {}, "旧称", "qwen3:4b", "旧称")).toEqual(["qwen3:4b"]);
  });
});
