import type { AttachmentSummary } from "../../contracts/ipc";

export const MAX_COMPOSER_ATTACHMENTS = 3;

export function attachmentDetail(attachment: AttachmentSummary): string {
  if (attachment.kind === "PDF") {
    return `${attachment.pageCount ?? 0} 页 · ${attachment.chunkCount} 个片段`;
  }
  if (attachment.kind === "DOCX") {
    return `${attachment.chunkCount} 个片段`;
  }
  const rows = attachment.sheets.reduce((total, sheet) => total + sheet.rows, 0);
  return `${attachment.sheets.length} 个工作表 · ${rows} 行`;
}
