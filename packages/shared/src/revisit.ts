import { Temporal } from "@js-temporal/polyfill";

export const DEFAULT_HOUSEHOLD_TIMEZONE = "Europe/Berlin" as const;
export const DEFAULT_DATE_ONLY_REVISIT_TIME = "06:00" as const;

export type RevisitDaypart = "morning" | "afternoon" | "evening";

export interface RevisitDaypartPolicy {
  defaultTime: string;
  startHour: number;
  endHour: number;
}

export const REVISIT_DAYPART_POLICIES: Record<
  RevisitDaypart,
  RevisitDaypartPolicy
> = {
  morning: { defaultTime: "08:00", startHour: 6, endHour: 11 },
  afternoon: { defaultTime: "15:00", startHour: 13, endHour: 17 },
  evening: { defaultTime: "19:00", startHour: 19, endHour: 22 },
};

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

function acceptsNormalized(status: RevisitInputStatus): boolean {
  return status === "normalized" || status === "unchanged";
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

/** Creates a new timestamp for a date-only choice without changing legacy normalization. */
export function newDateOnlyRevisitAt(
  date: string,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  return householdCalendarDateTimeToRevisitAt(
    date,
    DEFAULT_DATE_ONLY_REVISIT_TIME,
    timezone,
  );
}

export function householdCalendarDateTimeToRevisitAt(
  date: string,
  time: string,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  const normalized = normalizeRevisitInput(`${date}T${time}`, timezone);
  return acceptsNormalized(normalized.status)
    ? normalized.value
    : null;
}

/**
 * Resolves a date change while keeping an existing local clock. New
 * date-only timestamps use the product's 06:00 fallback.
 */
export function resolveDateOnlyRevisitChange(
  date: string,
  existing: string | null | undefined,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  if (!existing) return newDateOnlyRevisitAt(date, timezone);
  return moveRevisitToCalendarDate(existing, date, timezone);
}

function ceilToNextHour(time: Temporal.PlainTime): Temporal.PlainTime | null {
  const hour = time.minute === 0 && time.second === 0 && time.millisecond === 0
    ? time.hour
    : time.hour + 1;
  if (hour > 23) return null;
  return Temporal.PlainTime.from({ hour, minute: 0 });
}

/**
 * Resolves a daypart suggestion from an injected instant. Same-day
 * suggestions require a 30-minute lead and never roll into tomorrow.
 */
export function resolveRevisitDaypart(
  daypart: RevisitDaypart,
  now: string | Temporal.Instant,
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
  date: string = Temporal.Instant.from(now).toZonedDateTimeISO(timezone).toPlainDate().toString(),
): string | null {
  const policy = REVISIT_DAYPART_POLICIES[daypart];
  const nowInstant = Temporal.Instant.from(now);
  const zonedNow = nowInstant.toZonedDateTimeISO(timezone);
  const targetDate = Temporal.PlainDate.from(date);
  const today = zonedNow.toPlainDate();
  if (Temporal.PlainDate.compare(targetDate, today) < 0) return null;
  let targetTime = Temporal.PlainTime.from(policy.defaultTime);

  if (targetDate.equals(today)) {
    const earliest = zonedNow.add({ minutes: 30 });
    if (Temporal.PlainTime.compare(targetTime, earliest.toPlainTime()) < 0) {
      const rounded = ceilToNextHour(earliest.toPlainTime());
      if (!rounded) return null;
      targetTime = rounded;
    }
  }

  if (
    targetTime.hour < policy.startHour ||
    targetTime.hour > policy.endHour ||
    (targetTime.hour === policy.endHour && targetTime.minute > 0)
  ) {
    return null;
  }
  return householdCalendarDateTimeToRevisitAt(
    targetDate.toString(),
    targetTime.toString({ smallestUnit: "minute" }),
    timezone,
  );
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
