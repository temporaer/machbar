import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isSnoozeActive,
  readSnoozeEntries,
  writeSnoozeEntries,
  type TaskSnoozeEntry,
} from "./taskSnooze";

/**
 * Unit coverage for the client-only, member-scoped same-day snooze
 * primitive — see `taskSnoozeContext.tsx` (the provider that consumes
 * these functions) and `TaskLaterSheet.tsx` (the sole writer). These are
 * deliberately plain function tests, not component renders: the storage
 * key scoping and expiry logic are pure and cheap to verify directly.
 */
describe("taskSnooze", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns no entries when nothing has been stored yet", () => {
    expect(readSnoozeEntries(1)).toEqual([]);
    expect(readSnoozeEntries(null)).toEqual([]);
  });

  it("round-trips entries written for a given member through localStorage", () => {
    const entries: TaskSnoozeEntry[] = [
      { taskId: 7, until: "2026-09-14T20:00:00.000Z" },
    ];
    writeSnoozeEntries(entries, 1);

    expect(readSnoozeEntries(1)).toEqual(entries);
  });

  it("scopes snooze storage per member, so one member's snooze never leaks to another", () => {
    writeSnoozeEntries([{ taskId: 7, until: "2026-09-14T20:00:00.000Z" }], 1);
    writeSnoozeEntries([{ taskId: 9, until: "2026-09-14T21:00:00.000Z" }], 2);

    expect(readSnoozeEntries(1)).toEqual([{ taskId: 7, until: "2026-09-14T20:00:00.000Z" }]);
    expect(readSnoozeEntries(2)).toEqual([{ taskId: 9, until: "2026-09-14T21:00:00.000Z" }]);
    expect(readSnoozeEntries(null)).toEqual([]);
  });

  it("ignores malformed stored data instead of throwing", () => {
    window.localStorage.setItem("machbar:task-snooze:1", "not json");
    expect(readSnoozeEntries(1)).toEqual([]);

    window.localStorage.setItem(
      "machbar:task-snooze:1",
      JSON.stringify([{ taskId: "not-a-number", until: 5 }, { taskId: 3, until: "ok" }]),
    );
    expect(readSnoozeEntries(1)).toEqual([{ taskId: 3, until: "ok" }]);
  });

  it("treats an entry as active only strictly before its 'until' instant", () => {
    const entry: TaskSnoozeEntry = { taskId: 1, until: "2026-09-14T20:00:00.000Z" };

    expect(isSnoozeActive(entry, new Date("2026-09-14T19:59:59.000Z"))).toBe(true);
    expect(isSnoozeActive(entry, new Date("2026-09-14T20:00:00.000Z"))).toBe(false);
    expect(isSnoozeActive(entry, new Date("2026-09-14T20:00:01.000Z"))).toBe(false);
  });
});
