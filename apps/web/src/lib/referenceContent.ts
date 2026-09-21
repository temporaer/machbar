/**
 * Presentation-only projection of a reference node's `notes` markdown into
 * a primary web link, its Paperless attachments (via the existing
 * `paperlessAttachments` helpers), and the remaining free text. Mirrors
 * `paperlessAttachments.ts`'s small pure-function, mdast-based style. This
 * never edits or re-serializes notes -- Markdown stays the storage/
 * interchange representation; mobile users only ever see the derived
 * projection.
 */
import type { Nodes, Parent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  extractPaperlessReferences,
  markdownWithoutPaperlessReferences,
  paperlessDocumentId,
  type PaperlessMarkdownReference,
} from "./paperlessAttachments";

export interface PrimaryWebLink {
  url: string;
  label: string;
}

export interface ParsedReferenceContent {
  primaryWebLink: PrimaryWebLink | null;
  paperlessAttachments: PaperlessMarkdownReference[];
  remainingText: string;
}

interface LocatedWebLink extends PrimaryWebLink {
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

function hostnameLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isWebUrl(url: string | undefined): url is string {
  if (!url) return false;
  return /^https?:\/\//i.test(url) && paperlessDocumentId(url) === null;
}

/** First `http`/`https` link in document order (autolink text or
 * `[label](url)`); a bare URL falls back to its hostname as the label. */
function locatePrimaryWebLink(markdown: string): LocatedWebLink | null {
  let found: LocatedWebLink | null = null;
  const visit = (node: Nodes) => {
    if (found) return;
    if (node.type === "link" && isWebUrl(node.url)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const rawLabel = nodeText(node).trim();
        found = {
          url: node.url,
          label: rawLabel && rawLabel !== node.url ? rawLabel : hostnameLabel(node.url),
          start,
          end,
        };
      }
      return;
    }
    if (node.type === "text" && !found) {
      // Plain autolink text (no explicit `[label](url)` markup): scan for
      // the first bare http(s) URL inside this text node.
      const match = node.value.match(/https?:\/\/[^\s)\]]+/i);
      const nodeStart = node.position?.start.offset;
      if (match && match.index !== undefined && nodeStart !== undefined) {
        const url = match[0];
        found = {
          url,
          label: hostnameLabel(url),
          start: nodeStart + match.index,
          end: nodeStart + match.index + url.length,
        };
        return;
      }
    }
    if ("children" in node) {
      for (const child of (node as Parent).children) {
        if (found) break;
        visit(child);
      }
    }
  };
  visit(fromMarkdown(markdown));
  return found;
}

export function parseReferenceContent(notes: string): ParsedReferenceContent {
  const paperlessAttachments = extractPaperlessReferences(notes);
  const withoutPaperless = markdownWithoutPaperlessReferences(notes);
  const located = locatePrimaryWebLink(withoutPaperless);
  const primaryWebLink = located
    ? { url: located.url, label: located.label }
    : null;
  const remainingText = located
    ? (
        withoutPaperless.slice(0, located.start) +
        withoutPaperless.slice(located.end)
      )
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : withoutPaperless.trim();
  return { primaryWebLink, paperlessAttachments, remainingText };
}
