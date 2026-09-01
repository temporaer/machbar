import type { PaperlessDocumentSummary } from "@machbar/shared";
import type { Nodes, Parent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { api } from "./api";

export interface UploadedPaperlessAttachment {
  document: PaperlessDocumentSummary;
  markdown: string;
}

export interface PaperlessMarkdownReference {
  id: number;
  label: string;
  kind: "image" | "document";
}

type PaperlessUploader = (
  file: File,
) => Promise<PaperlessDocumentSummary>;

const paperlessReferencePattern = /^paperless:([1-9]\d*)$/;

export function paperlessDocumentId(url: string | undefined): number | null {
  const match = url?.match(paperlessReferencePattern);
  if (!match?.[1]) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

interface LocatedPaperlessMarkdownReference extends PaperlessMarkdownReference {
  start: number;
  end: number;
}

function nodeText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) {
    return (node as Parent).children.map((child) => nodeText(child)).join("");
  }
  return "";
}

function locatePaperlessReferences(
  markdown: string,
): LocatedPaperlessMarkdownReference[] {
  const references: LocatedPaperlessMarkdownReference[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "link" || node.type === "image") {
      const id = paperlessDocumentId(node.url);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (id !== null && start !== undefined && end !== undefined) {
        const rawLabel = node.type === "image" ? node.alt ?? "" : nodeText(node);
        references.push({
          id,
          label: rawLabel.trim() || `paperless-${id}`,
          kind: node.type === "image" ? "image" : "document",
          start,
          end,
        });
      }
      return;
    }
    if ("children" in node) {
      for (const child of (node as Parent).children) visit(child);
    }
  };
  visit(fromMarkdown(markdown));
  return references;
}

export function extractPaperlessReferences(
  markdown: string,
): PaperlessMarkdownReference[] {
  return locatePaperlessReferences(markdown).map(({ id, label, kind }) => ({
    id,
    label,
    kind,
  }));
}

export function markdownWithoutPaperlessReferences(markdown: string): string {
  let projected = markdown;
  for (const reference of locatePaperlessReferences(markdown).reverse()) {
    projected =
      projected.slice(0, reference.start) + projected.slice(reference.end);
  }
  return projected
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function containsPaperlessReference(
  markdown: string,
  candidateMarkdown: string,
): boolean {
  const candidate = extractPaperlessReferences(candidateMarkdown)[0];
  return candidate
    ? extractPaperlessReferences(markdown).some(
        (reference) => reference.id === candidate.id,
      )
    : false;
}

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
  if (paperlessDocumentId(`paperless:${document.id}`) === null) {
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
