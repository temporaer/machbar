/**
 * Pure helpers for the GET parameters defined by the Web Share Target API.
 * Keeping this separate from any page lets a future share-target entry point
 * decide when and where a shared item should be captured.
 */
export interface WebShareTarget {
  title: string;
  text: string;
  url: string;
  files: File[];
}

export interface CaptureShareDraft {
  title: string;
  notes: string;
}

const SHORT_TEXT_LENGTH = 100;
const DERIVED_TITLE_LENGTH = 80;

/** Reads and normalizes the standard `title`, `text`, and `url` query parameters. */
export function parseWebShareTarget(params: URLSearchParams | string): WebShareTarget {
  const search = typeof params === "string" ? new URLSearchParams(params) : params;
  return {
    title: normalizeInline(search.get("title") ?? ""),
    text: normalizeBlock(search.get("text") ?? ""),
    url: normalizeInline(search.get("url") ?? ""),
    files: [],
  };
}

/**
 * Converts shared content into a Capture-compatible title and notes draft.
 *
 * A supplied page title wins. Without one, short text becomes the task title;
 * longer text remains intact in notes and contributes a compact first-line
 * title. URLs stay in Markdown notes and are not repeated when already present
 * in the shared text.
 */
export function shareTargetToCaptureDraft(
  target: WebShareTarget,
  locale: Locale = "de",
): CaptureShareDraft {
  const text = normalizeBlock(target.text);
  const url = normalizeInline(target.url);
  const shortText = isShortPlainText(text);
  const title =
    target.title ||
    (shortText ? normalizeInline(text) : deriveTitle(text)) ||
    url ||
    target.files[0]?.name ||
    getCatalog(locale).sharedContent;

  const noteParts: string[] = [];
  if (
    text &&
    (target.title || !shortText || isWebUrl(text))
  ) {
    noteParts.push(text);
  }
  if (url && !text.includes(url)) noteParts.push(url);

  return { title, notes: noteParts.join("\n\n") };
}

/** Returns the shared text and URL as a Markdown-ready source block. */
export function shareTargetToSource(target: WebShareTarget): string {
  const text = normalizeBlock(target.text);
  const url = normalizeInline(target.url);
  if (
    !target.title &&
    isShortPlainText(text) &&
    !/https?:\/\//i.test(text)
  ) {
    return url && !text.includes(url) ? url : "";
  }
  if (!text) return url;
  return url && !text.includes(url) ? appendTextBlock(text, url) : text;
}

/**
 * Produces a self-contained free-text block for appending to existing notes.
 * Duplicate title, text, and URL content is included only once.
 */
export function shareTargetToTextBlock(target: WebShareTarget): string {
  const parts: string[] = [];
  const title = normalizeBlock(target.title);
  const text = normalizeBlock(target.text);
  const url = normalizeInline(target.url);
  if (title) parts.push(title);
  if (text && normalizeInline(text) !== title) {
    parts.push(text);
  }
  if (
    url &&
    !text.includes(url) &&
    !title.includes(url)
  ) {
    parts.push(url);
  }
  return parts.join("\n\n");
}

/** Appends non-empty text blocks using exactly one blank line as a separator. */
export function appendTextBlock(existing: string, block: string): string {
  const addition = normalizeBlock(block);
  if (!addition) return existing;
  if (!existing.trim()) return addition;
  if (existing.endsWith("\n\n")) return `${existing}${addition}`;
  if (existing.endsWith("\n")) return `${existing}\n${addition}`;
  return `${existing}\n\n${addition}`;
}

function isShortPlainText(text: string): boolean {
  return text.length <= SHORT_TEXT_LENGTH && !/[\r\n]/.test(text);
}

function isWebUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text);
}

function deriveTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).find(Boolean) ?? "";
  const compact = normalizeInline(firstLine);
  if (!compact) return "";
  if (compact.length <= DERIVED_TITLE_LENGTH) return compact;
  const prefix = compact.slice(0, DERIVED_TITLE_LENGTH - 1).trimEnd();
  const lastSpace = prefix.lastIndexOf(" ");
  const wordBoundary = lastSpace > DERIVED_TITLE_LENGTH / 2 ? prefix.slice(0, lastSpace) : prefix;
  return `${wordBoundary}…`;
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeBlock(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}
import { getCatalog, type Locale } from "../i18n/catalog";
