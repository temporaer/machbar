import {
  DEFAULT_HOUSEHOLD_TIMEZONE,
  resolveRevisitDaypart,
  type RevisitDaypart,
} from "@machbar/shared";
import { Temporal } from "@js-temporal/polyfill";
import type { TaskReminderInput } from "@machbar/shared";

/**
 * Centralised reminder preset constants shared by `TaskRemindersSheet` and
 * its tests, so both read the same source of truth instead of the sheet
 * embedding magic offsets inline.
 *
 * Absolute presets resolve to a concrete ISO instant the moment they are
 * selected (see `resolveAbsolutePreset`) — they intentionally do not move
 * if the task's deadline later changes. Deadline-relative presets instead
 * produce a `daysBefore`/`time` pair that is recomputed against the
 * task's current deadline every time it is checked for being due.
 */
export const ABSOLUTE_REMINDER_PRESETS = [
  "tonight",
  "tomorrowMorning",
  "tomorrowEvening",
  "in1Hour",
  "in3Hours",
] as const;
export type AbsoluteReminderPreset = (typeof ABSOLUTE_REMINDER_PRESETS)[number];

export const DEADLINE_RELATIVE_REMINDER_PRESETS = [
  "sameDay",
  "eveningBefore",
  "twoDaysBefore",
  "oneWeekBefore",
] as const;
export type DeadlineRelativeReminderPreset = (typeof DEADLINE_RELATIVE_REMINDER_PRESETS)[number];

/** `daysBefore`/`time` defaults for each deadline-relative preset (spec: "the user can edit the time afterward"). */
export const DEADLINE_RELATIVE_REMINDER_PRESET_DEFAULTS: Record<
  DeadlineRelativeReminderPreset,
  { daysBefore: number; time: string }
> = {
  sameDay: { daysBefore: 0, time: "08:00" },
  eveningBefore: { daysBefore: 1, time: "19:00" },
  twoDaysBefore: { daysBefore: 2, time: "09:00" },
  oneWeekBefore: { daysBefore: 7, time: "09:00" },
};

/** Resolves an absolute preset to a concrete ISO instant, evaluated immediately at selection time. */
export function resolveAbsolutePreset(
  preset: AbsoluteReminderPreset,
  now = new Date(),
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): string | null {
  switch (preset) {
    case "tonight":
      return resolveRevisitDaypart("evening", now.toISOString(), timezone);
    case "tomorrowMorning": {
      return resolveFutureDaypart("morning", now, timezone);
    }
    case "tomorrowEvening": {
      return resolveFutureDaypart("evening", now, timezone);
    }
    case "in1Hour":
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    case "in3Hours":
      return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
  }

  function resolveFutureDaypart(
    daypart: RevisitDaypart,
    now: Date,
    timezone: string,
  ): string | null {
    const instant = Temporal.Instant.from(now.toISOString());
    const tomorrow = instant
      .toZonedDateTimeISO(timezone)
      .toPlainDate()
      .add({ days: 1 })
      .toString();
    return resolveRevisitDaypart(daypart, instant, timezone, tomorrow);
  }
}

/** Whether an absolute preset's shared target is still strictly in the future. */
export function absolutePresetIsFuture(
  preset: AbsoluteReminderPreset,
  now = new Date(),
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): boolean {
  const resolved = resolveAbsolutePreset(preset, now, timezone);
  return resolved !== null && new Date(resolved).getTime() > now.getTime();
}

/** Builds the `TaskReminderInput` for a selected absolute preset. */
export function absolutePresetReminderInput(
  preset: AbsoluteReminderPreset,
  now = new Date(),
  timezone: string = DEFAULT_HOUSEHOLD_TIMEZONE,
): TaskReminderInput {
  const at = resolveAbsolutePreset(preset, now, timezone);
  if (!at) throw new Error(`Reminder preset ${preset} is unavailable.`);
  return { kind: "absolute", at };
}

/** Builds the `TaskReminderInput` for a selected deadline-relative preset. */
export function relativePresetReminderInput(
  preset: DeadlineRelativeReminderPreset,
  timezone: string,
): TaskReminderInput {
  const { daysBefore, time } = DEADLINE_RELATIVE_REMINDER_PRESET_DEFAULTS[preset];
  return { kind: "deadline_relative", daysBefore, time, timezone };
}
