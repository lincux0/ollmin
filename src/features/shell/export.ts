import type { ExportPayload } from "../../contracts/ipc";

export function downloadExport(payload: ExportPayload): void {
  const blob = new Blob([payload.content], {
    type: payload.format === "json" ? "application/json" : "text/markdown",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = payload.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
