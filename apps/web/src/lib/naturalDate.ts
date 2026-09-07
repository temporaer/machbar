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

/**
 * Month-name lookup (full + common abbreviation) per locale, used only by
 * `parseYearlessMonthDay` below. Sugar's own month-name parsing is what
 * previously handled "oct 11"/"oktober 11" — but for German it silently
 * fell back to an unrelated absolute-date interpretation (observed:
 * "oktober 11" -> 2001-11-01) instead of failing, and for a yearless date
 * already past this year it never rolled over to next year. Matching the
 * month name explicitly here, before the generic Sugar fallback, avoids
 * both problems without touching any of the already-explicit patterns
 * above (ISO/localized-numeric/compact-relative/calendar-week).
 */
const MONTH_NAMES: Record<Locale, readonly string[][]> = {
  de: [
    ["januar", "jan"],
    ["februar", "feb"],
    ["märz", "maerz", "mrz", "mär"],
    ["april", "apr"],
    ["mai"],
    ["juni", "jun"],
    ["juli", "jul"],
    ["august", "aug"],
    ["september", "sep", "sept"],
    ["oktober", "okt"],
    ["november", "nov"],
    ["dezember", "dez"],
  ],
  en: [
    ["january", "jan"],
    ["february", "feb"],
    ["march", "mar"],
    ["april", "apr"],
    ["may"],
    ["june", "jun"],
    ["july", "jul"],
    ["august", "aug"],
    ["september", "sep", "sept"],
    ["october", "oct"],
    ["november", "nov"],
    ["december", "dec"],
  ],
};

function monthIndexFor(word: string, locale: Locale): number | null {
  const normalized = word.toLowerCase().replace(/\.$/, "");
  // Try the requested locale first, then the other — mirrors the existing
  // localized/alternate-date fallback pattern below, so e.g. an English
  // month name typed while the app is in German still resolves.
  const orderedLocales: Locale[] = locale === "en" ? ["en", "de"] : ["de", "en"];
  for (const candidateLocale of orderedLocales) {
    const index = MONTH_NAMES[candidateLocale].findIndex((names) =>
      names.includes(normalized),
    );
    if (index !== -1) return index + 1;
  }
  return null;
}

const MONTH_DAY_WORD_PATTERN = /^([a-zà-ÿ]+)\.?\s+(\d{1,2})\.?$/i;
const DAY_MONTH_WORD_PATTERN = /^(\d{1,2})\.?\s+([a-zà-ÿ]+)\.?$/i;

/**
 * Yearless "month name + day" input in either word order (`oct 11`,
 * `11 oct`, `oktober 11`, `11. Oktober`). Infers the current year from
 * `referenceDate`, rolling over to next year if that date already passed
 * (date-only comparison) — an explicit year elsewhere in the input is
 * handled by the numeric-date patterns above and never reaches here.
 */
function parseYearlessMonthDay(
  input: string,
  referenceDate: Date,
  locale: Locale,
): Date | null {
  const monthDayMatch = MONTH_DAY_WORD_PATTERN.exec(input);
  const dayMonthMatch = DAY_MONTH_WORD_PATTERN.exec(input);
  let monthWord: string | null = null;
  let dayStr: string | null = null;
  if (monthDayMatch) {
    monthWord = monthDayMatch[1]!;
    dayStr = monthDayMatch[2]!;
  } else if (dayMonthMatch) {
    dayStr = dayMonthMatch[1]!;
    monthWord = dayMonthMatch[2]!;
  } else {
    return null;
  }

  const month = monthIndexFor(monthWord, locale);
  if (month === null) return null;
  const day = Number(dayStr);
  const referenceYear = referenceDate.getFullYear();
  if (!isValidDateParts(referenceYear, month, day)) return null;

  let candidate = new Date(referenceYear, month - 1, day);
  const referenceDateOnly = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate(),
  );
  if (candidate.getTime() < referenceDateOnly.getTime()) {
    candidate = new Date(referenceYear + 1, month - 1, day);
  }
  return candidate;
}

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

export function addIsoCalendarDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
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

  const yearlessMonthDay = parseYearlessMonthDay(input, referenceDate, locale);
  if (yearlessMonthDay) return toIsoCalendarDate(yearlessMonthDay);

  const parsed =
    parseWithSugar(input, locale, referenceDate) ??
    parseWithSugar(input, locale === "de" ? "en" : "de", referenceDate);
  return parsed ? toIsoCalendarDate(parsed) : null;
}
