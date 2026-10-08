import {
  DEFAULT_HOUSEHOLD_TIMEZONE,
  householdCalendarDateTimeToRevisitAt,
  localTimeForInstant,
} from "@machbar/shared";

export interface TaskAvailabilityValue {
  notBeforeAt: string;
  notBeforeDate: string;
}

/** Resolves the same local date/time pair used by the task availability workflow. */
export function taskAvailabilityForLocalDate(
  date: string,
  time: string | null,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): TaskAvailabilityValue | null {
  const notBeforeAt = householdCalendarDateTimeToRevisitAt(
    date,
    time ?? "00:00",
    timezone,
  );
  return notBeforeAt ? { notBeforeAt, notBeforeDate: date } : null;
}

export function taskAvailabilityClock(
  instant: string | null,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  return localTimeForInstant(instant, timezone);
}
