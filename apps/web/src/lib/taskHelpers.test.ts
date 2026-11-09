import { describe, expect, it } from "vitest";
import { makeTask } from "../test/fixtures";
import {
  countTasks,
  hasOpenDescendants,
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
