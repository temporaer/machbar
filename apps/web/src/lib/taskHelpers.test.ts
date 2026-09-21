import { describe, expect, it } from "vitest";
import { makeTask } from "../test/fixtures";
import {
  countTasks,
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
