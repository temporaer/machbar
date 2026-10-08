import { describe, expect, it } from "vitest";
import {
  absolutePresetIsFuture,
  absolutePresetReminderInput,
  relativePresetReminderInput,
  resolveAbsolutePreset,
} from "./reminderPresets";

describe("reminderPresets", () => {
  const timezone = "Europe/Berlin";
  const now = new Date("2026-09-01T14:30:00.000Z");

  it("resolves 'tonight' to the next valid evening slot", () => {
    const at = resolveAbsolutePreset(
      "tonight",
      new Date("2026-09-01T18:00:00+02:00"),
      timezone,
    );
    expect(at).toBe("2026-09-01T17:00:00Z");
  });

  it("adapts tonight to the current clock and hides it when no time remains", () => {
    const beforeEvening = new Date("2026-09-19T18:00:00+02:00");
    const afterEvening = new Date("2026-09-19T21:45:00+02:00");

    expect(absolutePresetIsFuture("tonight", beforeEvening, timezone)).toBe(
      true,
    );
    expect(
      resolveAbsolutePreset(
        "tonight",
        new Date("2026-09-19T20:00:00+02:00"),
        timezone,
      ),
    ).toBe("2026-09-19T19:00:00Z");
    expect(absolutePresetIsFuture("tonight", afterEvening, timezone)).toBe(
      false,
    );
    expect(
      resolveAbsolutePreset(
        "tonight",
        new Date("2026-09-19T23:45:00+02:00"),
        timezone,
      ),
    ).toBeNull();
    expect(
      absolutePresetIsFuture(
        "tonight",
        new Date("2026-09-19T23:45:00+02:00"),
        timezone,
      ),
    ).toBe(false);
  });

  it("resolves 'tomorrowMorning' to 08:00 the next local day", () => {
    expect(resolveAbsolutePreset("tomorrowMorning", now, timezone)).toBe(
      "2026-09-02T06:00:00Z",
    );
  });

  it("resolves 'tomorrowEvening' to 19:00 the next local day", () => {
    expect(resolveAbsolutePreset("tomorrowEvening", now, timezone)).toBe(
      "2026-09-02T17:00:00Z",
    );
  });

  it("resolves 'in1Hour' and 'in3Hours' relative to now", () => {
    expect(resolveAbsolutePreset("in1Hour", now)).toBe(
      new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    );
    expect(resolveAbsolutePreset("in3Hours", now)).toBe(
      new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("builds an absolute reminder input resolved immediately, independent of any deadline", () => {
    const input = absolutePresetReminderInput("in1Hour", now, timezone);
    expect(input).toEqual({
      kind: "absolute",
      at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    });
  });

  it("builds deadline-relative reminder inputs with the documented suggested defaults", () => {
    expect(relativePresetReminderInput("sameDay", "Europe/Berlin")).toEqual({
      kind: "deadline_relative",
      daysBefore: 0,
      time: "08:00",
      timezone: "Europe/Berlin",
    });
    expect(
      relativePresetReminderInput("eveningBefore", "Europe/Berlin"),
    ).toEqual({
      kind: "deadline_relative",
      daysBefore: 1,
      time: "19:00",
      timezone: "Europe/Berlin",
    });
    expect(
      relativePresetReminderInput("twoDaysBefore", "Europe/Berlin"),
    ).toEqual({
      kind: "deadline_relative",
      daysBefore: 2,
      time: "09:00",
      timezone: "Europe/Berlin",
    });
    expect(
      relativePresetReminderInput("oneWeekBefore", "Europe/Berlin"),
    ).toEqual({
      kind: "deadline_relative",
      daysBefore: 7,
      time: "09:00",
      timezone: "Europe/Berlin",
    });
  });
});
