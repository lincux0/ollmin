import { describe, expect, it } from "vitest";
import { modelAliasFor, modelName } from "./helpers";

describe("model feature helpers", () => {
  it("accepts both Ollama model field shapes", () => {
    expect(modelName({ name: "qwen3:4b" })).toBe("qwen3:4b");
    expect(modelName({ model: "llama3.2:3b" })).toBe("llama3.2:3b");
  });

  it("prefers an explicitly configured alias", () => {
    expect(modelAliasFor({ "qwen3:4b": "办公助手" }, "qwen3:4b", "旧别名")).toBe("办公助手");
    expect(modelAliasFor({}, "qwen3:4b", "旧别名")).toBe("旧别名");
  });
});
