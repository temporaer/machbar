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

function atLocalTime(date: Date, hours: number, minutes: number): Date {
  const result = new Date(date);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

/** Resolves an absolute preset to a concrete ISO instant, evaluated immediately at selection time. */
export function resolveAbsolutePreset(preset: AbsoluteReminderPreset, now = new Date()): string {
  switch (preset) {
    case "tonight":
      return atLocalTime(now, 19, 0).toISOString();
    case "tomorrowMorning": {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return atLocalTime(tomorrow, 8, 0).toISOString();
    }
    case "tomorrowEvening": {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return atLocalTime(tomorrow, 19, 0).toISOString();
    }
    case "in1Hour":
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    case "in3Hours":
      return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
  }
}

/** Builds the `TaskReminderInput` for a selected absolute preset. */
export function absolutePresetReminderInput(
  preset: AbsoluteReminderPreset,
  now = new Date(),
): TaskReminderInput {
  return { kind: "absolute", at: resolveAbsolutePreset(preset, now) };
}

/** Builds the `TaskReminderInput` for a selected deadline-relative preset. */
export function relativePresetReminderInput(
  preset: DeadlineRelativeReminderPreset,
  timezone: string,
): TaskReminderInput {
  const { daysBefore, time } = DEADLINE_RELATIVE_REMINDER_PRESET_DEFAULTS[preset];
  return { kind: "deadline_relative", daysBefore, time, timezone };
}
