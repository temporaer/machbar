import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RECENT_SHARE_TARGETS,
  readRecentShareTargets,
  rememberShareTarget,
} from "./recentShareTargets";

describe("recentShareTargets", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the most recent typed destination first", () => {
    rememberShareTarget({ kind: "project", id: 1 });
    rememberShareTarget({ kind: "task", id: 2 });
    expect(readRecentShareTargets()).toEqual([
      { kind: "task", id: 2 },
      { kind: "project", id: 1 },
    ]);
  });

  it("does not collide a task id with the same project id", () => {
    rememberShareTarget({ kind: "project", id: 12 });
    rememberShareTarget({ kind: "task", id: 12 });
    expect(readRecentShareTargets()).toEqual([
      { kind: "task", id: 12 },
      { kind: "project", id: 12 },
    ]);
  });

  it("moves a repeated destination to the front and bounds the list", () => {
    for (let id = 1; id <= MAX_RECENT_SHARE_TARGETS + 2; id += 1) {
      rememberShareTarget({ kind: "task", id });
    }
    rememberShareTarget({ kind: "task", id: 3 });
    const targets = readRecentShareTargets();
    expect(targets).toHaveLength(MAX_RECENT_SHARE_TARGETS);
    expect(targets[0]).toEqual({ kind: "task", id: 3 });
    expect(targets).not.toContainEqual({ kind: "task", id: 1 });
  });

  it("tolerates corrupt and foreign storage data", () => {
    window.localStorage.setItem("machbar:recent-share-targets", "not json");
    expect(readRecentShareTargets()).toEqual([]);

    window.localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify([{ kind: "task", id: 4 }, { kind: "other", id: 5 }, { kind: "project", id: "6" }]),
    );
    expect(readRecentShareTargets()).toEqual([{ kind: "task", id: 4 }]);
  });

  it("degrades safely when localStorage is unavailable", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(readRecentShareTargets()).toEqual([]);
    getItem.mockRestore();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(() => rememberShareTarget({ kind: "task", id: 4 })).not.toThrow();
    setItem.mockRestore();
  });
});
