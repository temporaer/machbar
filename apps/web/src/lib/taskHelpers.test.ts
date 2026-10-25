import { describe, expect, it } from "vitest";
import { makeTask } from "../test/fixtures";
import {
  countTasks,
  indexTaskDescendants,
  hasOpenDescendants,
  markOpenDescendantsTerminal,
  openDescendantRoots,
} from "./taskHelpers";

describe("taskHelpers reference transparency", () => {
  it("ignores a reference descendant with no open action children", () => {
    const task = makeTask({
      children: [
        makeTask({
          id: 2,
          kind: "reference",
          status: "actionable",
        }),
      ],
    });

    expect(hasOpenDescendants(task)).toBe(false);
  });

  it("finds an open action nested under a reference descendant", () => {
    const nestedAction = makeTask({ id: 3, status: "actionable" });
    const task = makeTask({
      children: [
        makeTask({
          id: 2,
          kind: "reference",
          status: "actionable",
          children: [nestedAction],
        }),
      ],
    });

    expect(hasOpenDescendants(task)).toBe(true);
    expect(openDescendantRoots(task)).toEqual([nestedAction]);
  });

  it("terminalizes nested actions without mutating reference descendants", () => {
    const at = "2026-09-21T09:00:00.000Z";
    const nestedAction = makeTask({ id: 3, status: "actionable" });
    const reference = makeTask({
      id: 2,
      kind: "reference",
      status: "actionable",
      children: [nestedAction],
    });

    const [updatedReference] = markOpenDescendantsTerminal([reference], "done", at);

    expect(updatedReference).toMatchObject({
      id: reference.id,
      kind: "reference",
      status: reference.status,
      completedAt: reference.completedAt,
      cancelledAt: reference.cancelledAt,
      children: [
        expect.objectContaining({
          id: nestedAction.id,
          kind: "action",
          status: "done",
          completedAt: at,
          cancelledAt: null,
          needsClarification: false,
        }),
      ],
    });
  });

  it("counts only action tasks while traversing through references", () => {
    const projectTasks = [
      makeTask({
        id: 10,
        kind: "reference",
        status: "actionable",
      }),
      makeTask({ id: 11, status: "actionable" }),
      makeTask({ id: 12, status: "done" }),
    ];

    expect(countTasks(projectTasks)).toEqual({ open: 1, done: 1 });
  });

  it("counts nested actions under references", () => {
    const projectTasks = [
      makeTask({
        id: 20,
        kind: "reference",
        status: "actionable",
        children: [makeTask({ id: 21, status: "actionable" })],
      }),
    ];

    expect(countTasks(projectTasks)).toEqual({ open: 1, done: 0 });
  });
});

describe("task descendant indexing", () => {
  it("reads each unique subtree once for an already flattened 400-task chain", () => {
    const nodes: ReturnType<typeof makeTask>[] = [];
    let reads = 0;
    for (let id = 400; id >= 1; id -= 1) {
      const children = nodes.length ? [nodes[0]!] : [];
      const task = makeTask({ id });
      Object.defineProperty(task, "children", { get: () => { reads += 1; return children; } });
      nodes.unshift(task);
    }
    const index = indexTaskDescendants([...nodes, ...nodes]);
    expect(reads).toBe(400);
    expect(index.size).toBe(400);
    expect(index.get(1)?.size).toBe(399);
    expect(index.get(200)?.size).toBe(200);
    expect(index.get(400)?.size).toBe(0);
    expect(index.get(1)?.has(400)).toBe(true);
  });
});
