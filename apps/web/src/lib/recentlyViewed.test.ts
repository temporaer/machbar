import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recencyRankLookup,
  recordRecentlyViewed,
} from "./recentlyViewed";

describe("recentlyViewed", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("ranks the most recently viewed id first, older ones after", () => {
    recordRecentlyViewed("task", 1);
    recordRecentlyViewed("task", 2);
    recordRecentlyViewed("task", 3);

    const rank = recencyRankLookup("task");
    expect(rank(3)).toBe(0);
    expect(rank(2)).toBe(1);
    expect(rank(1)).toBe(2);
    expect(rank(999)).toBe(Number.POSITIVE_INFINITY);
  });

  it("moves a re-viewed id back to the front without duplicating it", () => {
    recordRecentlyViewed("task", 1);
    recordRecentlyViewed("task", 2);
    recordRecentlyViewed("task", 1);

    const rank = recencyRankLookup("task");
    expect(rank(1)).toBe(0);
    expect(rank(2)).toBe(1);
  });

  it("keeps task and project recency independent", () => {
    recordRecentlyViewed("task", 5);
    recordRecentlyViewed("project", 5);

    expect(recencyRankLookup("task")(5)).toBe(0);
    expect(recencyRankLookup("project")(5)).toBe(0);
  });

  it("stops boosting entries once the recency window has elapsed", () => {
    const recordedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(recordedAt);
    recordRecentlyViewed("task", 1);

    const fourDaysLater = recordedAt + 4 * 24 * 60 * 60 * 1000;
    expect(recencyRankLookup("task", fourDaysLater)(1)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("degrades safely when storage is missing or corrupt", () => {
    window.localStorage.setItem("machbar:recently-viewed:task", "{not json");
    expect(recencyRankLookup("task")(1)).toBe(Number.POSITIVE_INFINITY);

    const getItemSpy = vi
      .spyOn(window.localStorage.__proto__, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => recencyRankLookup("task")).not.toThrow();
    expect(recencyRankLookup("task")(1)).toBe(Number.POSITIVE_INFINITY);
    getItemSpy.mockRestore();

    const setItemSpy = vi
      .spyOn(window.localStorage.__proto__, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => recordRecentlyViewed("task", 42)).not.toThrow();
    setItemSpy.mockRestore();
  });
});
