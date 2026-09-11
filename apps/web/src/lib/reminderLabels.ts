import type { Locale } from "../i18n/catalog";
import type { Strings } from "./strings";
import { localeTag } from "./format";
import {
  DEADLINE_RELATIVE_REMINDER_PRESET_DEFAULTS,
  type DeadlineRelativeReminderPreset,
} from "./reminderPresets";

/**
 * Shared shape covering both persisted `TaskReminder` and in-progress
 * `TaskReminderInput` drafts (which may not have an `id` yet) — labels and
 * sorting only need the reminder's content, not its identity.
 */
export type ReminderLike =
  | { kind: "absolute"; at: string }
  | { kind: "deadline_relative"; daysBefore: number; time: string; timezone: string };

function addCalendarDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * The concrete `"YYYY-MM-DDTHH:mm"` local occurrence a reminder currently
 * resolves to, for display/sorting only (the server independently
 * recomputes the same thing at due-check time). `null` when a
 * deadline-relative reminder has no deadline to resolve against yet.
 */
export function resolveReminderOccurrence(reminder: ReminderLike, dueDate: string | null): string | null {
  if (reminder.kind === "absolute") return reminder.at;
  if (dueDate === null) return null;
  const targetDate = addCalendarDays(dueDate, -reminder.daysBefore);
  return `${targetDate}T${reminder.time}`;
}

/** Sorts a reminder list chronologically, placing reminders with no resolvable occurrence (dormant relative reminders) last. */
export function sortRemindersForDisplay<T extends ReminderLike>(reminders: T[], dueDate: string | null): T[] {
  return [...reminders].sort((a, b) => {
    const occA = resolveReminderOccurrence(a, dueDate);
    const occB = resolveReminderOccurrence(b, dueDate);
    if (occA === null && occB === null) return 0;
    if (occA === null) return 1;
    if (occB === null) return -1;
    return occA < occB ? -1 : occA > occB ? 1 : 0;
  });
}

function matchRelativePreset(daysBefore: number): DeadlineRelativeReminderPreset | null {
  for (const [preset, defaults] of Object.entries(DEADLINE_RELATIVE_REMINDER_PRESET_DEFAULTS)) {
    if (defaults.daysBefore === daysBefore) return preset as DeadlineRelativeReminderPreset;
  }
  return null;
}

function shortDateLabel(iso: string, locale: Locale): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(localeTag(locale), { day: "numeric", month: "short" }).format(date);
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatAbsoluteReminderLabel(at: string, strings: Strings, locale: Locale, now: Date): string {
  const target = new Date(at);
  const hh = String(target.getHours()).padStart(2, "0");
  const mm = String(target.getMinutes()).padStart(2, "0");
  const time = `${hh}:${mm}`;

  // Minute-level granularity below one hour so a reminder due soon visibly
  // counts down across reloads instead of sitting on the same rounded
  // "In 1 hour" label for the entire 30–90 minute window that would round
  // to one hour.
  const diffMinutes = (target.getTime() - now.getTime()) / (60 * 1000);
  const diffHours = diffMinutes / 60;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (sameCalendarDay(target, now) && target.getHours() >= 18) {
    return `${strings.reminderPresetLabels.tonight} · ${time}`;
  }
  if (sameCalendarDay(target, tomorrow) && target.getHours() < 12) {
    return `${strings.reminderPresetLabels.tomorrowMorning} · ${time}`;
  }
  if (sameCalendarDay(target, tomorrow) && target.getHours() >= 18) {
    return `${strings.reminderPresetLabels.tomorrowEvening} · ${time}`;
  }
  if (diffMinutes > 0 && diffMinutes < 60) {
    return strings.reminderInMinutes(Math.max(1, Math.round(diffMinutes)));
  }
  if (diffHours >= 1 && diffHours < 6) {
    return strings.reminderInHours(Math.round(diffHours));
  }
  return `${shortDateLabel(at, locale)} · ${time}`;
}

function formatRelativeReminderLabel(
  reminder: Extract<ReminderLike, { kind: "deadline_relative" }>,
  dueDate: string | null,
  strings: Strings,
): string {
  const preset = matchRelativePreset(reminder.daysBefore);
  const label = preset ? strings.reminderRelativePresetLabels[preset] : strings.reminderDaysBeforeLabel(reminder.daysBefore);
  const base = `${label} · ${reminder.time}`;
  return dueDate === null ? `${base} · ${strings.reminderNoDeadline}` : base;
}

/** Formats a single reminder's compact human-readable label — see the format examples in the reminders spec. */
export function formatReminderLabel(
  reminder: ReminderLike,
  dueDate: string | null,
  strings: Strings,
  locale: Locale,
  now = new Date(),
): string {
  if (reminder.kind === "absolute") return formatAbsoluteReminderLabel(reminder.at, strings, locale, now);
  return formatRelativeReminderLabel(reminder, dueDate, strings);
}

/** The compact `detail-meta-row` summary: the first (chronologically) reminder's label, plus a `+N` overflow badge. */
export function formatReminderSummary(
  reminders: ReminderLike[],
  dueDate: string | null,
  strings: Strings,
  locale: Locale,
  now = new Date(),
): { label: string; overflowCount: number } {
  const sorted = sortRemindersForDisplay(reminders, dueDate);
  const [first, ...rest] = sorted;
  return {
    label: first ? formatReminderLabel(first, dueDate, strings, locale, now) : "",
    overflowCount: rest.length,
  };
}
