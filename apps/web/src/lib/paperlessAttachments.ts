import type { PaperlessDocumentSummary } from "@machbar/shared";
import { api } from "./api";

export interface UploadedPaperlessAttachment {
  document: PaperlessDocumentSummary;
  markdown: string;
}

type PaperlessUploader = (
  file: File,
) => Promise<PaperlessDocumentSummary>;

function markdownLabel(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]])/g, "\\$1")
    .trim();
}

function documentLabel(document: PaperlessDocumentSummary): string {
  return document.originalFileName.trim() || document.title.trim() || `paperless-${document.id}`;
}

export function isPaperlessImage(
  document: Pick<PaperlessDocumentSummary, "mimeType">,
): boolean {
  return document.mimeType?.toLowerCase().startsWith("image/") ?? false;
}

export function paperlessMarkdownReference(
  document: PaperlessDocumentSummary,
  label = documentLabel(document),
): string {
  if (!Number.isSafeInteger(document.id) || document.id < 1) {
    throw new Error("Paperless document IDs must be positive integers.");
  }
  const escapedLabel = markdownLabel(label) || `paperless-${document.id}`;
  return isPaperlessImage(document)
    ? `![${escapedLabel}](paperless:${document.id})`
    : `[${escapedLabel}](paperless:${document.id})`;
}

export async function uploadPaperlessFile(
  file: File,
  upload: PaperlessUploader = api.uploadPaperlessDocument,
): Promise<UploadedPaperlessAttachment> {
  const uploaded = await upload(file);
  const document = {
    ...uploaded,
    originalFileName: uploaded.originalFileName || file.name,
    mimeType: uploaded.mimeType || file.type || null,
  };
  return {
    document,
    markdown: paperlessMarkdownReference(document, file.name),
  };
}

export async function uploadPaperlessFiles(
  files: readonly File[],
  upload: PaperlessUploader = api.uploadPaperlessDocument,
): Promise<UploadedPaperlessAttachment[]> {
  const uploaded: UploadedPaperlessAttachment[] = [];
  for (const file of files) {
    uploaded.push(await uploadPaperlessFile(file, upload));
  }
  return uploaded;
}

export function paperlessAttachmentBlock(
  attachments: readonly UploadedPaperlessAttachment[],
): string {
  return attachments.map(({ markdown }) => markdown).join("\n\n");
}
