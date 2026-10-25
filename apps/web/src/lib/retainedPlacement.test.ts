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
});
