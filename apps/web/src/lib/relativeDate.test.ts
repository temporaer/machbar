import { describe, expect, it } from "vitest";
import {
  formatCompactWaitDuration,
  formatRelativeDueDate,
  formatRelativeScheduleDate,
} from "./relativeDate";

const TODAY = new Date(2026, 7, 25, 23, 30);

describe("relative calendar dates", () => {
  it.each([
    ["2026-08-22", "3 Tage überfällig"],
    ["2026-08-25", "heute"],
    ["2026-08-28", "in 3 Tagen"],
    ["2026-09-08", "in 2 Wochen"],
  ])("formats %s as %s", (date, expected) => {
    expect(formatRelativeDueDate(date, TODAY)).toBe(expected);
  });

  it("keeps an elapsed schedule prompt persistent", () => {
    expect(formatRelativeScheduleDate("2026-08-22", TODAY)).toBe("seit 3 Tagen");
  });

  it("formats due and elapsed dates in English", () => {
    expect(formatRelativeDueDate("2026-09-08", TODAY, "en")).toBe(
      "in 2 weeks",
    );
    expect(formatRelativeDueDate("2026-08-22", TODAY, "en")).toBe(
      "3 days overdue",
    );
    expect(formatRelativeScheduleDate("2026-08-22", TODAY, "en")).toBe(
      "3 days ago",
    );
  });

  it("uses local calendar days across a daylight-saving boundary", () => {
    const beforeDstChange = new Date(2026, 2, 28, 23, 45);
    expect(formatRelativeDueDate("2026-03-30", beforeDstChange)).toBe("in 2 Tagen");
  });

  it("rejects invalid calendar dates", () => {
    expect(formatRelativeDueDate("2026-02-30", TODAY)).toBeNull();
  });

  it.each([
    ["2026-08-30", "5d"],
    ["2026-09-08", "2w"],
    ["2026-11-23", "3m"],
  ])("formats compact approximate waiting time for %s as %s", (date, expected) => {
    expect(formatCompactWaitDuration(date, TODAY)).toBe(expected);
  });

  it("does not describe elapsed waiting dates as remaining time", () => {
    expect(formatCompactWaitDuration("2026-08-24", TODAY)).toBeNull();
  });

  it("uses the English compact month abbreviation", () => {
    expect(formatCompactWaitDuration("2026-11-23", TODAY, "en")).toBe("3mo");
  });
});
