import Sugar from "sugar-date/index.js";
import "sugar-date/locales/de";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const GERMAN_DATE_PATTERN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const COMPACT_RELATIVE_PATTERN = /^(\d+)\s*([dwmy])$/i;

function isValidDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

export function toIsoCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoCalendarDate(input: string): string | null {
  const match = ISO_DATE_PATTERN.exec(input);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidDateParts(year, month, day) ? input : null;
}

function parseGermanCalendarDate(input: string): string | null {
  const match = GERMAN_DATE_PATTERN.exec(input);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (!isValidDateParts(year, month, day)) return null;
  return toIsoCalendarDate(new Date(year, month - 1, day));
}

function parseCompactRelative(input: string, referenceDate: Date): Date | null {
  const match = COMPACT_RELATIVE_PATTERN.exec(input);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const date = new Date(referenceDate);
  if (unit === "d") date.setDate(date.getDate() + amount);
  if (unit === "w") date.setDate(date.getDate() + amount * 7);
  if (unit === "m") date.setMonth(date.getMonth() + amount);
  if (unit === "y") date.setFullYear(date.getFullYear() + amount);
  return date;
}

function parseWithSugar(input: string, locale: "de" | "en", referenceDate: Date): Date | null {
  const previousClock = Sugar.Date.getOption<() => Date>("newDateInternal");
  Sugar.Date.setOption("newDateInternal", () => new Date(referenceDate));
  try {
    const parsed = Sugar.Date.create(input, { locale, future: true });
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } finally {
    Sugar.Date.setOption("newDateInternal", previousClock);
  }
}

export function parseNaturalDate(
  value: string,
  referenceDate = new Date(),
): string | null {
  const input = value.trim();
  if (!input || Number.isNaN(referenceDate.getTime())) return null;

  const isoDate = parseIsoCalendarDate(input);
  if (isoDate) return isoDate;
  if (ISO_DATE_PATTERN.test(input)) return null;
  const germanDate = parseGermanCalendarDate(input);
  if (germanDate) return germanDate;
  if (GERMAN_DATE_PATTERN.test(input)) return null;

  const compactDate = parseCompactRelative(input, referenceDate);
  if (compactDate) return toIsoCalendarDate(compactDate);

  const parsed =
    parseWithSugar(input, "de", referenceDate) ??
    parseWithSugar(input, "en", referenceDate);
  return parsed ? toIsoCalendarDate(parsed) : null;
}
