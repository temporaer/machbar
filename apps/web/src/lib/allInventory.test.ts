import { describe, expect, it } from "vitest";
import { makeProject, makeTask } from "../test/fixtures";
import {
  filterInventoryProjects,
  hasInventoryFilters,
  topLevelTaskResults,
} from "./allInventory";

describe("all inventory helpers", () => {
  it("matches project metadata and intentionally suppresses project cards for task-only filters", () => {
    const project = makeProject({
      id: 7,
      title: "Wohnung streichen",
      notes: "Vor dem Einzug",
      dueDate: "2026-09-10",
    });

    expect(filterInventoryProjects([project], { text: "einzug" })).toEqual([project]);
    expect(filterInventoryProjects([project], { dueTo: "2026-09-11" })).toEqual([project]);
    expect(filterInventoryProjects([project], { status: "done" })).toEqual([]);
    expect(hasInventoryFilters({})).toBe(false);
    expect(hasInventoryFilters({ tagIds: [3] })).toBe(true);
  });

  it("removes duplicate nested results while retaining a directly matched child", () => {
    const child = makeTask({ id: 2, parentTaskId: 1 });
    const parent = makeTask({ id: 1, children: [child] });

    expect(topLevelTaskResults([parent, child])).toEqual([parent]);
    expect(topLevelTaskResults([child])).toEqual([child]);
  });

  it("removes a deep match when any matched ancestor already contains it", () => {
    const grandchild = makeTask({ id: 3, parentTaskId: 2 });
    const child = makeTask({ id: 2, parentTaskId: 1, children: [grandchild] });
    const parent = makeTask({ id: 1, children: [child] });

    expect(topLevelTaskResults([parent, grandchild])).toEqual([parent]);
  });
});
