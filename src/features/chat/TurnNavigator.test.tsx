import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import TurnNavigator from "./TurnNavigator";

describe("TurnNavigator", () => {
  it("limits previews to ten characters without splitting emoji", () => {
    const html = renderToStaticMarkup(<TurnNavigator messages={[
      { id: "u1", role: "user", content: "😀一二三四五六七八九十" },
      { id: "u2", role: "user", content: "一二三四五六七八九十" },
    ]} currentId={null} onSelect={vi.fn()} />);
    expect(html).toContain('title="😀一二三四五六七八九……"');
    expect(html).toContain('title="一二三四五六七八九十"');
  });
  it("shows only loaded user turns and marks the current anchor", () => {
    const html = renderToStaticMarkup(
      <TurnNavigator
        messages={[
          { id: "u1", role: "user", content: "第一条问题" },
          { id: "a1", role: "assistant", content: "第一条回答" },
          { id: "u2", role: "user", content: "第二条问题" },
        ]}
        currentId="u2"
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="第 1 个问题：第一条问题"');
    expect(html).toContain('aria-current="location"');
    expect(html).not.toContain("第一条回答");
    expect(html).not.toContain("未加载");
  });

  it("omits the rail when fewer than two user turns are loaded", () => {
    const html = renderToStaticMarkup(
      <TurnNavigator messages={[{ id: "u1", role: "user", content: "问题" }]} currentId="u1" onSelect={vi.fn()} />,
    );

    expect(html).toBe("");
  });
});
