import type { Locale } from "../i18n/catalog";
import { parseNaturalDate } from "./naturalDate";
import type { WebShareTarget } from "./shareTarget";

export interface GoogleCalendarShareMetadata {
  source: "google-calendar";
  dueDate: string | null;
}

const GOOGLE_CALENDAR_URL = /\b(?:https?:\/\/)?calendar\.app\.google\/[^\s<>"']*/i;
const DATE_SIGNAL =
  /(?:\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}\b|\b(?:jan|feb|mär|mar|apr|mai|may|jun|jul|aug|sep|oct|okt|nov|dec|dez)[a-zä]*\.?\s+\d{1,2}\b|\b\d{1,2}\.?\s+(?:jan|feb|mär|mar|apr|mai|may|jun|jul|aug|sep|oct|okt|nov|dec|dez)[a-zä]*\.?)/i;
const TIME_SUFFIX =
  /(?:,|\s)\s*\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?(?:\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)?.*$/i;

function dateCandidates(line: string): string[] {
  const withoutUrl = line.replace(GOOGLE_CALENDAR_URL, "").trim();
  if (!withoutUrl || !DATE_SIGNAL.test(withoutUrl)) return [];

  const leadingMetadata = withoutUrl.split(/\s*[•·]\s*/, 1)[0]?.trim() ?? "";
  if (!leadingMetadata) return [];

  const candidates = [
    leadingMetadata,
    leadingMetadata.split(/\s+[–—-]\s+/, 1)[0]?.trim() ?? "",
    leadingMetadata.replace(TIME_SUFFIX, "").trim(),
  ];

  return [...new Set(candidates.filter(Boolean))];
}

export function parseGoogleCalendarShare(
  target: Pick<WebShareTarget, "title" | "text" | "url">,
  options: {
    locale?: Locale;
    referenceDate?: Date;
  } = {},
): GoogleCalendarShareMetadata | null {
  const fields = [target.title, target.text, target.url];
  if (!fields.some((field) => GOOGLE_CALENDAR_URL.test(field))) return null;

  const locale = options.locale ?? "de";
  const referenceDate = options.referenceDate ?? new Date();
  const lines = target.text.split("\n");

  for (const line of lines) {
    for (const candidate of dateCandidates(line)) {
      const dueDate = parseNaturalDate(candidate, referenceDate, locale);
      if (dueDate) return { source: "google-calendar", dueDate };
    }
  }

  return { source: "google-calendar", dueDate: null };
}
