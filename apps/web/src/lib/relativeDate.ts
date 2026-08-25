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

export function formatExactLocalDate(value: string): string | null {
  const date = parseCalendarDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(date.year, date.month - 1, date.day));
}

function futureRelative(days: number): string {
  if (days >= 7 && days % 7 === 0) {
    const weeks = days / 7;
    return `in ${weeks} ${weeks === 1 ? "Woche" : "Wochen"}`;
  }
  return `in ${days} ${days === 1 ? "Tag" : "Tagen"}`;
}

export function formatRelativeDueDate(value: string, now = new Date()): string | null {
  const days = calendarDayDifference(value, now);
  if (days === null) return null;
  if (days === 0) return "heute";
  if (days > 0) return futureRelative(days);
  const overdueDays = Math.abs(days);
  return `${overdueDays} ${overdueDays === 1 ? "Tag" : "Tage"} überfällig`;
}

export function formatRelativeScheduleDate(value: string, now = new Date()): string | null {
  const days = calendarDayDifference(value, now);
  if (days === null) return null;
  if (days === 0) return "heute";
  if (days > 0) return futureRelative(days);
  const elapsedDays = Math.abs(days);
  return `seit ${elapsedDays} ${elapsedDays === 1 ? "Tag" : "Tagen"}`;
}
