import Sugar from "sugar-date/index.js";
import "sugar-date/locales/de";
import type { Locale } from "../i18n/catalog";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const GERMAN_DATE_PATTERN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const ENGLISH_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const COMPACT_RELATIVE_PATTERN = /^(\d+)\s*([dwmy])$/i;
const GERMAN_CALENDAR_WEEK_PATTERN =
  /^(?:kw|kalenderwoche)\s*(\d{1,2})(?:\s*(?:\/|,)?\s*(\d{4}))?$/i;
const ENGLISH_CALENDAR_WEEK_PATTERN =
  /^(?:w|wk|week)\s*(\d{1,2})(?:\s*(?:\/|,)?\s*(\d{4}))?$/i;

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

function parseEnglishCalendarDate(input: string): string | null {
  const match = ENGLISH_DATE_PATTERN.exec(input);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
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

function isoWeekMonday(year: number, week: number): Date | null {
  if (week < 1 || week > 53) return null;
  const januaryFourth = new Date(year, 0, 4);
  const mondayOffset = (januaryFourth.getDay() + 6) % 7;
  const monday = new Date(year, 0, 4 - mondayOffset + (week - 1) * 7);

  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  return thursday.getFullYear() === year ? monday : null;
}

function parseCalendarWeek(
  input: string,
  referenceDate: Date,
  locale: Locale,
): Date | null {
  const pattern =
    locale === "en"
      ? ENGLISH_CALENDAR_WEEK_PATTERN
      : GERMAN_CALENDAR_WEEK_PATTERN;
  const match = pattern.exec(input);
  if (!match) return null;
  const week = Number(match[1]);
  const year = match[2] ? Number(match[2]) : referenceDate.getFullYear();
  return isoWeekMonday(year, week);
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
  locale: Locale = "de",
): string | null {
  const input = value.trim();
  if (!input || Number.isNaN(referenceDate.getTime())) return null;

  const isoDate = parseIsoCalendarDate(input);
  if (isoDate) return isoDate;
  if (ISO_DATE_PATTERN.test(input)) return null;
  const localizedDate =
    locale === "en"
      ? parseEnglishCalendarDate(input)
      : parseGermanCalendarDate(input);
  if (localizedDate) return localizedDate;
  const localizedDatePattern =
    locale === "en" ? ENGLISH_DATE_PATTERN : GERMAN_DATE_PATTERN;
  if (localizedDatePattern.test(input)) return null;

  const alternateDate =
    locale === "en"
      ? parseGermanCalendarDate(input)
      : parseEnglishCalendarDate(input);
  if (alternateDate) return alternateDate;

  const compactDate = parseCompactRelative(input, referenceDate);
  if (compactDate) return toIsoCalendarDate(compactDate);
  const calendarWeek = parseCalendarWeek(input, referenceDate, locale);
  if (calendarWeek) return toIsoCalendarDate(calendarWeek);
  const localizedWeekPattern =
    locale === "en"
      ? ENGLISH_CALENDAR_WEEK_PATTERN
      : GERMAN_CALENDAR_WEEK_PATTERN;
  if (localizedWeekPattern.test(input)) return null;

  const parsed =
    parseWithSugar(input, locale, referenceDate) ??
    parseWithSugar(input, locale === "de" ? "en" : "de", referenceDate);
  return parsed ? toIsoCalendarDate(parsed) : null;
}
