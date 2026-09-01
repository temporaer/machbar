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
 * title. URLs are always a distinct notes block rather than being run into
 * the prose around them.
 */
export function shareTargetToCaptureDraft(
  target: WebShareTarget,
  locale: Locale = "de",
): CaptureShareDraft {
  const shortText = isShortPlainText(target.text);
  const title =
    target.title ||
    (shortText ? normalizeInline(target.text) : deriveTitle(target.text)) ||
    target.url ||
    target.files[0]?.name ||
    getCatalog(locale).sharedContent;

  const noteParts: string[] = [];
  if (target.text && (target.title || !shortText)) noteParts.push(target.text);
  if (target.url) noteParts.push(target.url);

  return { title, notes: noteParts.join("\n\n") };
}

/**
 * Produces a self-contained free-text block for appending to existing notes.
 * Duplicate title/text values are included only once.
 */
export function shareTargetToTextBlock(target: WebShareTarget): string {
  const parts: string[] = [];
  if (target.title) parts.push(target.title);
  if (target.text && normalizeInline(target.text) !== target.title) parts.push(target.text);
  if (target.url) parts.push(target.url);
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
