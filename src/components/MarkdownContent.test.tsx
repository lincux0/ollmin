import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownContent from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders the supported basic Markdown blocks and inline styles", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={`介绍
### 三、行政区划
潍坊市下辖多个区县。

- **奎文区**：主城区
- 寒亭区

1. 第一项
2. 第二项

> 这是引用

---

[官方网站](https://example.com)`}
      />,
    );

    expect(html).toContain("<h3>三、行政区划</h3>");
    expect(html).toContain("<strong>奎文区</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr/>");
    expect(html).toContain('href="https://example.com"');
  });

  it("keeps formulas and code as escaped plain text instead of interpreting them", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content="$E=mc^2$ `const value = 1`\n\n```ts\nconst answer = 42;\n```" />,
    );

    expect(html).toContain("$E=mc^2$");
    expect(html).toContain("`const value = 1`");
    expect(html).toContain("const answer = 42;");
    expect(html).not.toContain("<code");
    expect(html).not.toContain("<pre");
  });

  it("does not turn unsafe links into clickable HTML", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content="[危险链接](javascript:alert(1))" />,
    );

    expect(html).not.toContain("href=");
    expect(html).toContain("[危险链接](javascript:alert(1))");
  });
});
