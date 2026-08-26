import { describe, expect, it } from "vitest";
import { resolveScheduleShortcut } from "./ScheduleShortcuts";

describe("resolveScheduleShortcut", () => {
  const thursday = new Date(2026, 7, 27, 12);

  it("uses local calendar dates for the common planning shortcuts", () => {
    expect(resolveScheduleShortcut("today", thursday)).toBe("2026-08-27");
    expect(resolveScheduleShortcut("tomorrow", thursday)).toBe("2026-08-28");
    expect(resolveScheduleShortcut("nextWeek", thursday)).toBe("2026-08-31");
    expect(resolveScheduleShortcut("weekend", thursday)).toBe("2026-08-29");
  });

  it("keeps Saturday as this weekend and moves Sunday to the upcoming Saturday", () => {
    expect(resolveScheduleShortcut("weekend", new Date(2026, 7, 29, 12))).toBe("2026-08-29");
    expect(resolveScheduleShortcut("weekend", new Date(2026, 7, 30, 12))).toBe("2026-09-05");
  });

  it("always interprets next week as the following Monday", () => {
    expect(resolveScheduleShortcut("nextWeek", new Date(2026, 7, 31, 12))).toBe("2026-09-07");
  });
});
