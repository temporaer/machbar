import { localDateTimeToIso } from "./localDateTime";

export interface TaskAvailabilityValue {
  notBeforeAt: string;
  notBeforeDate: string;
}

/** Resolves the same local date/time pair used by the task availability workflow. */
export function taskAvailabilityForLocalDate(
  date: string,
  time: string | null,
): TaskAvailabilityValue | null {
  const notBeforeAt = localDateTimeToIso(date, time ?? "00:00");
  return notBeforeAt ? { notBeforeAt, notBeforeDate: date } : null;
}

export function taskAvailabilityClock(instant: string | null): string | null {
  if (!instant) return null;
  const value = new Date(instant);
  if (Number.isNaN(value.getTime())) return null;
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}
