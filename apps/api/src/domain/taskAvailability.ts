import { Temporal } from "@js-temporal/polyfill";
import type { AvailabilityRule } from "@machbar/shared";

/** Pure wall-clock evaluation: no clock/database access or structural effects. */
export function isTaskAvailableInWindow(
  rule: AvailabilityRule | null,
  now: string,
  householdTimezone: string,
): boolean {
  if (rule === null) return true;
  const local = Temporal.Instant.from(now).toZonedDateTimeISO(householdTimezone);
  const time = local.toPlainTime();
  const inside = rule.windows.some((window) =>
    window.weekdays.includes(local.dayOfWeek) &&
    Temporal.PlainTime.compare(time, Temporal.PlainTime.from(window.start)) >= 0 &&
    Temporal.PlainTime.compare(time, Temporal.PlainTime.from(window.end)) < 0,
  );
  return rule.match === "inside" ? inside : !inside;
}
