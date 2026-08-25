import { describe, expect, it, beforeEach } from "vitest";
import {
  MAX_RECENT_DESTINATIONS,
  pickRecent,
  readRecentDestinationIds,
  rememberDestination,
} from "./recentDestinations";

/**
 * The local shortcut cache behind `DestinationPicker`. It is deliberately
 * forgiving: anything unusable (garbage in storage, a destination that no
 * longer exists) has to degrade to "no recents" rather than break refiling.
 */
describe("recentDestinations", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the most recently used destination first", () => {
    rememberDestination("project", 1);
    rememberDestination("project", 2);
    rememberDestination("project", 3);
    expect(readRecentDestinationIds("project")).toEqual([3, 2, 1]);
  });

  it("de-duplicates by moving a repeated destination back to the front", () => {
    rememberDestination("project", 1);
    rememberDestination("project", 2);
    rememberDestination("project", 1);
    expect(readRecentDestinationIds("project")).toEqual([1, 2]);
  });

  it(`caps the list at ${MAX_RECENT_DESTINATIONS} entries`, () => {
    for (let id = 1; id <= MAX_RECENT_DESTINATIONS + 3; id += 1) {
      rememberDestination("project", id);
    }
    const ids = readRecentDestinationIds("project");
    expect(ids).toHaveLength(MAX_RECENT_DESTINATIONS);
    expect(ids[0]).toBe(MAX_RECENT_DESTINATIONS + 3);
    expect(ids).not.toContain(1);
  });

  it("keeps project and parent destinations in separate lists", () => {
    rememberDestination("project", 7);
    rememberDestination("parent", 8);
    expect(readRecentDestinationIds("project")).toEqual([7]);
    expect(readRecentDestinationIds("parent")).toEqual([8]);
  });

  it("ignores the null destination — 'no project' needs no shortcut", () => {
    rememberDestination("project", null);
    expect(readRecentDestinationIds("project")).toEqual([]);
  });

  it("drops recents that are no longer available", () => {
    rememberDestination("project", 1);
    rememberDestination("project", 2);
    rememberDestination("project", 3);

    const available = [
      { id: 3, title: "Garten" },
      { id: 1, title: "Umzug" },
    ];
    expect(pickRecent("project", available)).toEqual([
      { id: 3, title: "Garten" },
      { id: 1, title: "Umzug" },
    ]);
  });

  it("survives corrupt or foreign storage contents", () => {
    window.localStorage.setItem("machbar:recent-destinations:project", "not json");
    expect(readRecentDestinationIds("project")).toEqual([]);

    window.localStorage.setItem(
      "machbar:recent-destinations:project",
      JSON.stringify(["4", null, 5, { id: 6 }]),
    );
    expect(readRecentDestinationIds("project")).toEqual([5]);
  });
});
