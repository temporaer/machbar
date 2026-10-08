import {
  DEFAULT_HOUSEHOLD_TIMEZONE,
  householdCalendarDateTimeToRevisitAt,
  householdCalendarDateToRevisitAt,
  calendarDateForInstant,
  localTimeForInstant,
  moveRevisitToCalendarDate,
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

export function taskRevisitForLocalDate(
  date: string,
  currentRevisitAt: string | null,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  if (!date) return null;
  if (!currentRevisitAt) return householdCalendarDateToRevisitAt(date, timezone);
  if (calendarDateForInstant(currentRevisitAt, timezone) === date) {
    return currentRevisitAt;
  }
  return moveRevisitToCalendarDate(currentRevisitAt, date, timezone);
}
