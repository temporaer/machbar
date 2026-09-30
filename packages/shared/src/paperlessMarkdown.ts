import type { PaperlessDocumentSummary } from "./index.js";

export function markdownLabel(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]])/g, "\\$1")
    .trim();
}

export function isPaperlessImage(
  document: Pick<PaperlessDocumentSummary, "mimeType">,
): boolean {
  return document.mimeType?.toLowerCase().startsWith("image/") ?? false;
}

export function paperlessMarkdownReference(
  document: PaperlessDocumentSummary,
  label = document.originalFileName.trim() || document.title.trim() || `paperless-${document.id}`,
): string {
  if (!Number.isSafeInteger(document.id) || document.id <= 0) {
    throw new Error("Paperless document IDs must be positive integers.");
  }
  const escapedLabel = markdownLabel(label) || `paperless-${document.id}`;
  return isPaperlessImage(document)
    ? `![${escapedLabel}](paperless:${document.id})`
    : `[${escapedLabel}](paperless:${document.id})`;
}
