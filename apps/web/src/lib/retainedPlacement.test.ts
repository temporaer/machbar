import { applyDescendantTerminalOutcome } from "./taskHelpers";
import { describe, expect, it } from "vitest";
import { retainPlacement } from "./retainedPlacement";
import { makeTask } from "../test/fixtures";

const task = (id: number) => makeTask({ id, title: `Task ${id}` });
const identity = <T,>(value: T) => value;

describe("retained list placement", () => {
  it("keeps the last task in its original Today bucket, without a completed-today duplicate", () => {
    const old = task(1);
    const done = { ...old, status: "done" as const };
    const buckets = retainPlacement({ today: [old], done: [] }, { today: [], done: [done] }, new Set([1]), () => done);
    expect(buckets.today).toEqual([done]);
    expect(buckets.done).toEqual([]);
    expect(retainPlacement(buckets, { today: [], done: [done] }, new Set(), identity)).toEqual({ today: [], done: [done] });
  });

  it("keeps the same slot when the server removes or reorders a held row", () => {
    const [a, b, c] = [task(1), task(2), task(3)];
    const result = retainPlacement({ rows: [a!, b!, c!] }, { rows: [c!, a!] }, new Set([2]), identity);
    expect(result.rows!.map(item => item.id)).toEqual([2, 3, 1]);
  });

  it("holds several independent rows without changing their relative order", () => {
    const rows = [task(1), task(2), task(3)];
    const result = retainPlacement({ rows }, { rows: [rows[2]!] }, new Set([1, 2]), identity);
    expect(result.rows!.map(item => item.id)).toEqual([1, 2, 3]);
  });

  it("keeps a removed child nested and does not inject a promoted duplicate", () => {
    const child = task(2);
    const parent = { ...task(1), children: [child] };
    const result = retainPlacement({ today: [parent], done: [] }, { today: [{ ...parent, children: [] }], done: [child] }, new Set([2]), identity);
    expect(result.today![0]!.children.map(item => item.id)).toEqual([2]);
    expect(result.done).toEqual([]);
  });

  it("preserves an ancestor path when the compiled response removes the whole subtree", () => {
    const parent = { ...task(1), children: [{ ...task(2), children: [task(3)] }] };
    const result = retainPlacement({ rows: [parent] }, { rows: [] }, new Set([3]), identity);
    expect(result.rows).toEqual([parent]);
  });

  it("does not inject a transition observed only in another view", () => {
    expect(retainPlacement({ rows: [task(2)] }, { rows: [task(2)] }, new Set([1]), identity).rows).toEqual([task(2)]);
  });
  it("owns open descendants while their completed parent is retained, then releases them to their new bucket", () => {
    const child = { ...task(2), children: [task(3)] };
    const parent = { ...task(1), children: [child] };
    const done = { ...parent, status: "done" as const };
    const current = { today: [], additional: [child], done: [{ ...done, children: [] }] };
    const latest = (value: typeof parent) => value.id === 1 ? done : value;
    const held = retainPlacement({ today: [parent], additional: [], done: [] }, current, new Set([1]), latest);
    expect(held.today).toEqual([done]);
    expect(held.additional).toEqual([]);
    expect(held.done).toEqual([]);
    expect(retainPlacement(held, current, new Set(), identity)).toEqual(current);
  });

  it("reconstructs only held paths when an absent ancestor has a promoted unheld sibling", () => {
    const held = task(2);
    const sibling = task(3);
    const parent = { ...task(1), children: [held, sibling] };
    const done = { ...held, status: "done" as const, revision: 2 };
    const result = retainPlacement({ today: [parent], other: [] },
      { today: [], other: [done, sibling] }, new Set([2]), identity);
    expect(result.today![0]!.children).toEqual([done]);
    expect(result.other).toEqual([sibling]);
  });

  it.each([false, true])("uses newer current values from another location, nested: %s", nested => {
    const old = task(1);
    const fresh = { ...old, title: "Changed elsewhere", status: "someday" as const, revision: 3 };
    const destination = nested ? [{ ...task(2), children: [fresh] }] : [fresh];
    const result = retainPlacement({ today: [old], other: [] },
      { today: [], other: destination }, new Set([1]), identity);
    expect(result.today).toEqual([fresh]);
    expect(nested ? result.other![0]!.children : result.other).toEqual([]);
  });

  it("does bounded tree work when nothing is held in an unchanged 400-task chain", () => {
    let root = task(400);
    let reads = 0;
    for (let id = 399; id >= 1; id -= 1) {
      const child = root;
      root = task(id);
      Object.defineProperty(root, "children", { enumerable: true, get: () => { reads += 1; return [child]; } });
    }
    const result = retainPlacement({ rows: [root] }, { rows: [root] }, new Set(), identity);
    expect(reads).toBeLessThan(400 * 12);
    let count = 0;
    let row = result.rows![0];
    while (row) { count += 1; row = row.children[0]; }
    expect(count).toBe(400);
  });

  it("keeps fresh child membership during a parent hold while applying retained values", () => {
    const original = task(2);
    const moved = task(3);
    const parent = { ...task(1), children: [original] };
    const snapshot = { ...parent, title: "Renamed", revision: 2 };
    const current = { ...snapshot, children: [original, moved] };
    const result = retainPlacement({ rows: [parent, moved] }, { rows: [current] }, new Set([1]),
      item => item.id === 1 ? snapshot : item);
    expect(result.rows![0]!.title).toBe("Renamed");
    expect(result.rows![0]!.children.map(item => item.id)).toEqual([2, 3]);
    expect(result.rows).toHaveLength(1);
  });

  it("keeps equal-revision authoritative derived and future fields after a parent title edit", () => {
    const child = { ...task(2), blocked: true, executable: false, futureMetric: "old" };
    const parent = { ...task(1), children: [child] };
    const snapshot = { ...parent, title: "Renamed", revision: 2 };
    const refreshed = { ...child, blocked: false, executable: true, futureMetric: "fresh" };
    const result = retainPlacement({ rows: [parent] }, { rows: [{ ...snapshot, children: [refreshed] }] },
      new Set([1]), item => item.id === 1 ? snapshot : item, applyDescendantTerminalOutcome);
    expect(result.rows![0]!.children[0]).toMatchObject({ blocked: false, executable: true, futureMetric: "fresh" });
  });

  it("overlays only lifecycle fields for an inherited terminal policy at equal revision", () => {
    const child = { ...task(2), blocked: true, futureMetric: "old" };
    const parent = { ...task(1), children: [child] };
    const completed = { ...child, status: "done" as const, completedAt: "2026-10-25T12:00:00Z", needsClarification: false };
    const snapshot = { ...parent, status: "done" as const, revision: 2, children: [completed] };
    const freshChild = { ...child, blocked: false, futureMetric: "fresh" };
    const result = retainPlacement({ rows: [parent] }, { rows: [{ ...parent, children: [freshChild] }] },
      new Set([1]), item => item.id === 1 ? snapshot : item, applyDescendantTerminalOutcome);
    expect(result.rows![0]!.children[0]).toMatchObject({ status: "done", completedAt: completed.completedAt, blocked: false, futureMetric: "fresh" });
  });

});
