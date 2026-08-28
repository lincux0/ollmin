import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MessageItem, { areMessageItemPropsEqual, type MessageItemData } from "./MessageItem";
import MarkdownContent, { areMarkdownContentPropsEqual } from "./MarkdownContent";

const assistant: MessageItemData = {
  id: "assistant-1",
  role: "assistant",
  content: "## 正文\n\n- 第一项",
  thinking: "先整理要点",
  status: "streaming",
};

describe("message rendering boundaries", () => {
  it("keeps Markdown output escaped and preserves message controls", () => {
    const html = renderToStaticMarkup(
      <MessageItem message={assistant} copied={false} onCopy={vi.fn()} />,
    );

    expect(html).toContain("思考过程");
    expect(html).toContain("生成中");
    expect(html).toContain("复制");
    expect(html).toContain("正文");

    const escaped = renderToStaticMarkup(<MarkdownContent content="<script>alert(1)</script>" />);
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).not.toContain("<script>");
  });

  it("shows the conversation model alias for assistant messages", () => {
    const html = renderToStaticMarkup(
      <MessageItem
        message={{ ...assistant, modelAlias: "本地助手" }}
        copied={false}
        onCopy={vi.fn()}
      />,
    );

    expect(html).toContain("本地助手");
    expect(html).not.toContain(">模型</span>");
  });

  it("renders local attachments beneath the user message", () => {
    const html = renderToStaticMarkup(
      <MessageItem
        message={{
          id: "user-attachment",
          role: "user",
          content: "请根据附件总结。",
          status: "done",
          attachments: [{
            id: "attachment-1",
            name: "调研方案.pdf",
            kind: "PDF",
            sizeBytes: 100,
            textCharacters: 500,
            chunkCount: 2,
            pageCount: 3,
            sheets: [],
            warnings: [],
          }],
        }}
        copied={false}
        onCopy={vi.fn()}
      />,
    );

    expect(html).toContain("调研方案.pdf");
    expect(html).toContain("已作为本地参考资料发送");
  });

  it("only invalidates a message row when its message or copied state changes", () => {
    const onCopy = vi.fn();
    expect(areMessageItemPropsEqual(
      { message: assistant, copied: false, onCopy },
      { message: assistant, copied: false, onCopy: vi.fn() },
    )).toBe(true);
    expect(areMessageItemPropsEqual(
      { message: assistant, copied: false, onCopy },
      { message: assistant, copied: true, onCopy },
    )).toBe(false);

    expect(areMarkdownContentPropsEqual({ content: assistant.content }, { content: assistant.content })).toBe(true);
    expect(areMarkdownContentPropsEqual({ content: assistant.content }, { content: `${assistant.content}!` })).toBe(false);
  });
});
