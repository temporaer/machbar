import { describe, expect, it } from "vitest";
import {
  absolutePresetReminderInput,
  relativePresetReminderInput,
  resolveAbsolutePreset,
} from "./reminderPresets";

describe("reminderPresets", () => {
  const now = new Date("2026-09-01T14:30:00.000Z");

  it("resolves 'tonight' to 19:00 the same local day", () => {
    const at = resolveAbsolutePreset("tonight", now);
    const resolved = new Date(at);
    expect(resolved.getDate()).toBe(now.getDate());
    expect(resolved.getHours()).toBe(19);
    expect(resolved.getMinutes()).toBe(0);
  });

  it("resolves 'tomorrowMorning' to 08:00 the next local day", () => {
    const at = resolveAbsolutePreset("tomorrowMorning", now);
    const resolved = new Date(at);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(resolved.getDate()).toBe(tomorrow.getDate());
    expect(resolved.getHours()).toBe(8);
  });

  it("resolves 'tomorrowEvening' to 19:00 the next local day", () => {
    const at = resolveAbsolutePreset("tomorrowEvening", now);
    const resolved = new Date(at);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(resolved.getDate()).toBe(tomorrow.getDate());
    expect(resolved.getHours()).toBe(19);
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
    const input = absolutePresetReminderInput("in1Hour", now);
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
    expect(relativePresetReminderInput("eveningBefore", "Europe/Berlin")).toEqual({
      kind: "deadline_relative",
      daysBefore: 1,
      time: "19:00",
      timezone: "Europe/Berlin",
    });
    expect(relativePresetReminderInput("twoDaysBefore", "Europe/Berlin")).toEqual({
      kind: "deadline_relative",
      daysBefore: 2,
      time: "09:00",
      timezone: "Europe/Berlin",
    });
    expect(relativePresetReminderInput("oneWeekBefore", "Europe/Berlin")).toEqual({
      kind: "deadline_relative",
      daysBefore: 7,
      time: "09:00",
      timezone: "Europe/Berlin",
    });
  });
});
