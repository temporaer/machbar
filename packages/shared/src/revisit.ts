import { Temporal } from "@js-temporal/polyfill";

export const DEFAULT_HOUSEHOLD_TIMEZONE = "Europe/Berlin" as const;

export type RevisitInputStatus =
  | "normalized"
  | "unchanged"
  | "ambiguous"
  | "nonexistent"
  | "invalid";

export interface RevisitInputNormalization {
  value: string;
  status: RevisitInputStatus;
  timezone: string;
}

function parseInput(value: string): {
  date: string;
  time: string;
  offset: string | null;
} | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const [, date, hour, minute, second = "00", fraction = "", offset = null] =
    match;
  if (!date || hour === undefined) {
    return { date: date ?? "", time: "00:00:00.000", offset: null };
  }
  return {
    date,
    time: `${hour}:${minute}:${second}${fraction}`,
    offset,
  };
}

/**
 * Converts a revisit date or local wall-clock timestamp into one absolute
 * instant using the configured household timezone. DST gaps and overlaps are
 * rejected instead of silently choosing a different instant.
 */
export function normalizeRevisitInput(
  value: string,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): RevisitInputNormalization {
  const parsed = parseInput(value);
  if (!parsed) {
    return { value, status: "invalid", timezone };
  }
  if (parsed.offset !== null) {
    const date = new Date(`${parsed.date}T${parsed.time}${parsed.offset}`);
    if (Number.isNaN(date.getTime())) {
      return { value, status: "invalid", timezone };
    }
    const normalized = date.toISOString();
    return {
      value: normalized,
      status: normalized === value ? "unchanged" : "normalized",
      timezone,
    };
  }
  try {
    const [year, month, day] = parsed.date.split("-").map(Number);
    const [hour, minute, secondAndFraction] = parsed.time.split(":");
    const [second, fraction = ""] = (secondAndFraction ?? "00").split(".");
    const candidate = Temporal.ZonedDateTime.from(
      {
        timeZone: timezone,
        year: year!,
        month: month!,
        day: day!,
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second),
        millisecond: Number(fraction.padEnd(3, "0").slice(0, 3) || 0),
      },
      { disambiguation: "reject" },
    );
    return {
      value: candidate.toInstant().toString(),
      status: "normalized",
      timezone,
    };
  } catch {
    try {
      const [year, month, day] = parsed.date.split("-").map(Number);
      const [hour, minute, secondAndFraction] = parsed.time.split(":");
      const [second, fraction = ""] = (secondAndFraction ?? "00").split(".");
      const plain = Temporal.PlainDateTime.from({
        year: year!,
        month: month!,
        day: day!,
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second),
        millisecond: Number(fraction.padEnd(3, "0").slice(0, 3) || 0),
      });
      const earlier = Temporal.ZonedDateTime.from(
        {
          timeZone: timezone,
          year: year!,
          month: month!,
          day: day!,
          hour: Number(hour),
          minute: Number(minute),
          second: Number(second),
          millisecond: Number(fraction.padEnd(3, "0").slice(0, 3) || 0),
        },
        { disambiguation: "earlier" },
      );
      const later = Temporal.ZonedDateTime.from(
        {
          timeZone: timezone,
          year: year!,
          month: month!,
          day: day!,
          hour: Number(hour),
          minute: Number(minute),
          second: Number(second),
          millisecond: Number(fraction.padEnd(3, "0").slice(0, 3) || 0),
        },
        { disambiguation: "later" },
      );
      return {
        value,
        status:
          earlier.toPlainDateTime().equals(plain) &&
          later.toPlainDateTime().equals(plain)
            ? "ambiguous"
            : "nonexistent",
        timezone,
      };
    } catch {
      return { value, status: "invalid", timezone };
    }
  }
}

export function householdCalendarDateToRevisitAt(
  date: string,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  const normalized = normalizeRevisitInput(date, timezone);
  return normalized.status === "normalized" || normalized.status === "unchanged"
    ? normalized.value
    : null;
}

export function householdCalendarDateTimeToRevisitAt(
  date: string,
  time: string,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  const normalized = normalizeRevisitInput(`${date}T${time}`, timezone);
  return normalized.status === "normalized" || normalized.status === "unchanged"
    ? normalized.value
    : null;
}

export function localTimeForInstant(
  value: string | null | undefined,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  if (!value) return null;
  try {
    const time = Temporal.Instant.from(value).toZonedDateTimeISO(timezone).toPlainTime();
    return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

export function moveRevisitToCalendarDate(
  value: string,
  date: string,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  const time = localTimeForInstant(value, timezone);
  return time ? householdCalendarDateTimeToRevisitAt(date, time, timezone) : null;
}

export function calendarDateForInstant(
  value: string | null | undefined,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  if (!value) return null;
  try {
    const instant = Temporal.Instant.from(value);
    return instant.toZonedDateTimeISO(timezone).toPlainDate().toString();
  } catch {
    return null;
  }
}
