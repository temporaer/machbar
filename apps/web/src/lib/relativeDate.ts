import { getCatalog, type Locale } from "../i18n/catalog";
import { localeTag } from "./format";

const DAY_MS = 86_400_000;

function parseCalendarDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function calendarDayDifference(value: string, now: Date): number | null {
  const date = parseCalendarDate(value);
  if (!date || Number.isNaN(now.getTime())) return null;
  const targetDay = Date.UTC(date.year, date.month - 1, date.day);
  const localToday = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((targetDay - localToday) / DAY_MS);
}

export function formatExactLocalDate(
  value: string,
  locale: Locale = "de",
): string | null {
  const date = parseCalendarDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(date.year, date.month - 1, date.day));
}

function futureRelative(days: number, locale: Locale): string {
  const strings = getCatalog(locale);
  if (days >= 7 && days % 7 === 0) {
    return strings.inWeeks(days / 7);
  }
  return strings.inDays(days);
}

export function formatRelativeDueDate(
  value: string,
  now = new Date(),
  locale: Locale = "de",
): string | null {
  const days = calendarDayDifference(value, now);
  if (days === null) return null;
  const strings = getCatalog(locale);
  if (days === 0) return strings.todayRelative;
  if (days > 0) return futureRelative(days, locale);
  return strings.overdueDays(Math.abs(days));
}

export function formatRelativeScheduleDate(
  value: string,
  now = new Date(),
  locale: Locale = "de",
): string | null {
  const days = calendarDayDifference(value, now);
  if (days === null) return null;
  const strings = getCatalog(locale);
  if (days === 0) return strings.todayRelative;
  if (days > 0) return futureRelative(days, locale);
  return strings.sinceDays(Math.abs(days));
}

export function formatCompactWaitDuration(
  value: string,
  now = new Date(),
  locale: Locale = "de",
): string | null {
  const days = calendarDayDifference(value, now);
  if (days === null || days < 0) return null;
  const strings = getCatalog(locale);
  if (days < 7) return strings.compactDays(days);
  if (days < 60) return strings.compactWeeks(Math.round(days / 7));
  return strings.compactMonths(Math.round(days / 30));
}
