import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StatusPill from "./StatusPill";

describe("StatusPill", () => {
  it("keeps the existing online and offline class contract", () => {
    expect(renderToStaticMarkup(<StatusPill online label="Ollama 0.33.3" />)).toContain(
      'class="status-pill online"',
    );
    expect(renderToStaticMarkup(<StatusPill online={false} label="Ollama 未连接" />)).toContain(
      'class="status-pill offline"',
    );
  });
});
