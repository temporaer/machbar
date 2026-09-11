import { describe, expect, it } from "vitest";
import { de } from "../i18n/de";
import { en } from "../i18n/en";
import {
  formatReminderLabel,
  formatReminderSummary,
  resolveReminderOccurrence,
  sortRemindersForDisplay,
} from "./reminderLabels";

describe("reminderLabels", () => {
  describe("resolveReminderOccurrence", () => {
    it("resolves an absolute reminder to its own instant", () => {
      expect(resolveReminderOccurrence({ kind: "absolute", at: "2026-09-01T08:00:00.000Z" }, null)).toBe(
        "2026-09-01T08:00:00.000Z",
      );
    });

    it("resolves a deadline-relative reminder against the given due date", () => {
      const occurrence = resolveReminderOccurrence(
        { kind: "deadline_relative", daysBefore: 2, time: "09:00", timezone: "UTC" },
        "2026-09-20",
      );
      expect(occurrence).toBe("2026-09-18T09:00");
    });

    it("is null for a deadline-relative reminder with no current deadline", () => {
      expect(
        resolveReminderOccurrence(
          { kind: "deadline_relative", daysBefore: 2, time: "09:00", timezone: "UTC" },
          null,
        ),
      ).toBeNull();
    });
  });

  describe("sortRemindersForDisplay", () => {
    it("sorts reminders chronologically and places unresolvable (dormant) reminders last", () => {
      const late = { kind: "absolute", at: "2026-09-05T08:00:00.000Z" } as const;
      const early = { kind: "absolute", at: "2026-09-01T08:00:00.000Z" } as const;
      const dormant = { kind: "deadline_relative", daysBefore: 1, time: "09:00", timezone: "UTC" } as const;
      const sorted = sortRemindersForDisplay([late, dormant, early], null);
      expect(sorted).toEqual([early, late, dormant]);
    });
  });

  describe("formatReminderLabel", () => {
    const now = new Date(2026, 8, 1, 16, 0, 0);

    it("labels a same-evening absolute reminder as 'Heute Abend' in German", () => {
      const label = formatReminderLabel(
        { kind: "absolute", at: new Date(2026, 8, 1, 19, 0, 0).toISOString() },
        null,
        de,
        "de",
        now,
      );
      expect(label).toBe("Heute Abend · 19:00");
    });

    it("labels the same reminder as 'Tonight' in English", () => {
      const label = formatReminderLabel(
        { kind: "absolute", at: new Date(2026, 8, 1, 19, 0, 0).toISOString() },
        null,
        en,
        "en",
        now,
      );
      expect(label).toBe("Tonight · 19:00");
    });

    it("labels a tomorrow-morning absolute reminder", () => {
      const label = formatReminderLabel(
        { kind: "absolute", at: new Date(2026, 8, 2, 8, 0, 0).toISOString() },
        null,
        de,
        "de",
        now,
      );
      expect(label).toBe("Morgen früh · 08:00");
    });

    it("falls back to a short date + time for an arbitrary absolute reminder", () => {
      const label = formatReminderLabel(
        { kind: "absolute", at: new Date(2026, 8, 18, 14, 30, 0).toISOString() },
        null,
        de,
        "de",
        now,
      );
      expect(label).toContain("14:30");
      expect(label).toMatch(/Sept?\.?/);
    });

    it("labels a reminder due in under an hour with live minute granularity, not a frozen hour rounding", () => {
      // Regression: an "In 1 Stunde" preset reminder must count down through
      // minutes as it approaches, instead of staying "In 1 Stunde" for the
      // entire 30–90 minute window that would otherwise round to one hour.
      const dueIn40Minutes = new Date(now.getTime() + 40 * 60 * 1000);
      expect(formatReminderLabel({ kind: "absolute", at: dueIn40Minutes.toISOString() }, null, de, "de", now)).toBe(
        "In 40 Minuten",
      );

      const dueIn1Minute = new Date(now.getTime() + 60 * 1000);
      expect(formatReminderLabel({ kind: "absolute", at: dueIn1Minute.toISOString() }, null, de, "de", now)).toBe(
        "In 1 Minute",
      );
    });

    it("labels a reminder due in one to six hours with hour granularity", () => {
      const morningNow = new Date(2026, 8, 1, 10, 0, 0);
      const dueIn3Hours = new Date(morningNow.getTime() + 3 * 60 * 60 * 1000);
      expect(
        formatReminderLabel({ kind: "absolute", at: dueIn3Hours.toISOString() }, null, de, "de", morningNow),
      ).toBe("In 3 Stunden");
      expect(
        formatReminderLabel({ kind: "absolute", at: dueIn3Hours.toISOString() }, null, en, "en", morningNow),
      ).toBe("In 3 hours");
    });

    it("labels a deadline-relative preset match (2 days before) with its resolved time", () => {
      const label = formatReminderLabel(
        { kind: "deadline_relative", daysBefore: 2, time: "09:00", timezone: "UTC" },
        "2026-09-20",
        de,
        "de",
        now,
      );
      expect(label).toBe("2 Tage vorher · 09:00");
    });

    it("marks a deadline-relative reminder inactive when there is no current deadline", () => {
      const label = formatReminderLabel(
        { kind: "deadline_relative", daysBefore: 2, time: "09:00", timezone: "UTC" },
        null,
        de,
        "de",
        now,
      );
      expect(label).toBe("2 Tage vorher · 09:00 · keine Deadline");
    });

    it("marks an English deadline-relative reminder inactive when there is no current deadline", () => {
      const label = formatReminderLabel(
        { kind: "deadline_relative", daysBefore: 2, time: "09:00", timezone: "UTC" },
        null,
        en,
        "en",
        now,
      );
      expect(label).toContain("no deadline");
    });
  });

  describe("formatReminderSummary", () => {
    it("returns the first (chronological) reminder's label plus an overflow count", () => {
      const now = new Date(2026, 8, 1, 8, 0, 0);
      const summary = formatReminderSummary(
        [
          { kind: "absolute", at: new Date(2026, 8, 3, 8, 0, 0).toISOString() },
          { kind: "absolute", at: new Date(2026, 8, 1, 19, 0, 0).toISOString() },
          { kind: "absolute", at: new Date(2026, 8, 2, 8, 0, 0).toISOString() },
        ],
        null,
        de,
        "de",
        now,
      );
      expect(summary.label).toBe("Heute Abend · 19:00");
      expect(summary.overflowCount).toBe(2);
    });

    it("has no overflow for a single reminder", () => {
      const summary = formatReminderSummary(
        [{ kind: "absolute", at: new Date(2026, 8, 1, 19, 0, 0).toISOString() }],
        null,
        de,
        "de",
        new Date(2026, 8, 1, 8, 0, 0),
      );
      expect(summary.overflowCount).toBe(0);
    });
  });
});
