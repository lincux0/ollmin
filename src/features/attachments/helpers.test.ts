import { describe, expect, it } from "vitest";
import { attachmentDetail } from "./helpers";
import type { AttachmentSummary } from "../../contracts/ipc";

const baseAttachment: AttachmentSummary = {
  id: "attachment-1",
  name: "会议纪要.docx",
  kind: "DOCX",
  sizeBytes: 100,
  textCharacters: 20,
  chunkCount: 2,
  pageCount: null,
  sheets: [],
  warnings: [],
};

describe("attachment feature helpers", () => {
  it("keeps the existing summary wording for document attachments", () => {
    expect(attachmentDetail(baseAttachment)).toBe("2 个片段");
    expect(
      attachmentDetail({
        ...baseAttachment,
        kind: "PDF",
        pageCount: 3,
      }),
    ).toBe("3 页 · 2 个片段");
  });
});
