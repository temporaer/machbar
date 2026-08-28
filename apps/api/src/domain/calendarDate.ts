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
