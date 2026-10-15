import { eq } from "drizzle-orm";
import { DEFAULT_HOUSEHOLD_TIMEZONE } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";

/**
 * React-free household calendar helpers shared by the reflection briefing and
 * the goals/interventions derived-state computation. Calendar dates are strict
 * `YYYY-MM-DD` values in the household timezone (never timestamp arithmetic).
 */

/** Formats an instant as a `YYYY-MM-DD` calendar date in the given IANA zone. */
export function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Reads the configured household timezone, falling back to the shared default
 * when unset or invalid.
 */
export function householdTimezone(db: Db): string {
  const value =
    db
      .select({ value: schema.householdSettings.value })
      .from(schema.householdSettings)
      .where(eq(schema.householdSettings.key, "timezone"))
      .get()?.value ?? DEFAULT_HOUSEHOLD_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return DEFAULT_HOUSEHOLD_TIMEZONE;
  }
}

/** The current calendar date (`YYYY-MM-DD`) in the household timezone. */
export function householdToday(db: Db, now: Date = new Date()): string {
  return localDate(now, householdTimezone(db));
}
