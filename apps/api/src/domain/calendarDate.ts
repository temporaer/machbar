import { AppError } from "../errors.js";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Whole calendar days from `from` to `to` (`to - from`), positive when `to`
 * is later. Both must be strict `YYYY-MM-DD` values; the subtraction is done
 * in UTC so it is immune to DST, matching the rest of the calendar helpers.
 */
export function calendarDaysBetween(from: string, to: string): number {
  for (const value of [from, to]) {
    if (!isIsoCalendarDate(value)) {
      throw AppError.badRequest(
        "recurrence_configuration_invalid",
        "A calendar date must use a valid YYYY-MM-DD value.",
        { value },
      );
    }
  }
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromMs = Date.UTC(fy!, fm! - 1, fd!);
  const toMs = Date.UTC(ty!, tm! - 1, td!);
  return Math.round((toMs - fromMs) / 86_400_000);
}

export function addCalendarDays(value: string, days: number): string {
  if (!isIsoCalendarDate(value)) {
    throw AppError.badRequest(
      "recurrence_configuration_invalid",
      "The recurrence date must use a valid YYYY-MM-DD calendar date.",
      { value },
    );
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
