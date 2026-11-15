import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RECENT_MATERIAL_TARGETS,
  readRecentMaterialTargets,
  readRecentNoteTargets,
  rememberMaterialTarget,
  rememberNoteTarget,
} from "./recentShareTargets";

describe("recentShareTargets", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the most recent typed destination first", () => {
    rememberMaterialTarget({ kind: "project", id: 1 });
    rememberMaterialTarget({ kind: "task", id: 2 });
    expect(readRecentMaterialTargets()).toEqual([
      { kind: "task", id: 2 },
      { kind: "project", id: 1 },
    ]);
  });

  it("does not collide a task id with the same project id", () => {
    rememberMaterialTarget({ kind: "project", id: 12 });
    rememberMaterialTarget({ kind: "task", id: 12 });
    expect(readRecentMaterialTargets()).toEqual([
      { kind: "task", id: 12 },
      { kind: "project", id: 12 },
    ]);
  });

  it("moves a repeated destination to the front and bounds the list", () => {
    for (let id = 1; id <= MAX_RECENT_MATERIAL_TARGETS + 2; id += 1) {
      rememberMaterialTarget({ kind: "task", id });
    }
    rememberMaterialTarget({ kind: "task", id: 3 });
    const targets = readRecentMaterialTargets();
    expect(targets).toHaveLength(MAX_RECENT_MATERIAL_TARGETS);
    expect(targets[0]).toEqual({ kind: "task", id: 3 });
    expect(targets).not.toContainEqual({ kind: "task", id: 1 });
  });

  it("keeps note-append history separate from material destinations", () => {
    rememberMaterialTarget({ kind: "project", id: 1 });
    rememberNoteTarget({ kind: "task", id: 2 });
    rememberNoteTarget({ kind: "project", id: 3 });

    expect(readRecentMaterialTargets()).toEqual([{ kind: "project", id: 1 }]);
    expect(readRecentNoteTargets()).toEqual([
      { kind: "project", id: 3 },
      { kind: "task", id: 2 },
    ]);
  });

  it("keeps only three note-append destinations", () => {
    for (let id = 1; id <= 4; id += 1) {
      rememberNoteTarget({ kind: "task", id });
    }

    expect(readRecentNoteTargets()).toEqual([
      { kind: "task", id: 4 },
      { kind: "task", id: 3 },
      { kind: "task", id: 2 },
    ]);
  });

  it("tolerates corrupt and foreign storage data", () => {
    window.localStorage.setItem("machbar:recent-share-targets", "not json");
    expect(readRecentMaterialTargets()).toEqual([]);

    window.localStorage.setItem(
      "machbar:recent-share-targets",
      JSON.stringify([{ kind: "task", id: 4 }, { kind: "other", id: 5 }, { kind: "project", id: "6" }]),
    );
    expect(readRecentMaterialTargets()).toEqual([{ kind: "task", id: 4 }]);
  });

  it("degrades safely when localStorage is unavailable", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(readRecentMaterialTargets()).toEqual([]);
    getItem.mockRestore();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(() => rememberMaterialTarget({ kind: "task", id: 4 })).not.toThrow();
    setItem.mockRestore();
  });
});
