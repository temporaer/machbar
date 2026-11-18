import { describe, expect, it } from "vitest";
import { makeTask } from "../test/fixtures";
import {
  composeTaskListRows,
  removeTransitionAndRebase,
  transitionSourceIndex,
  type TaskListTransitionEntry,
} from "./taskListTransitionPresentation";

function transition(taskId: number, title: string, sourceIndex: number): TaskListTransitionEntry {
  return {
    task: makeTask({ id: taskId, title }),
    event: {
      taskId,
      targetStatus: "done",
      occurrence: false,
      phase: "success",
      sourceRevision: 1,
      resultStatus: "done",
      resultRevision: 2,
    },
    sourceOutlineId: "outline",
    sourceIndex,
  };
}

describe("task list transition presentation", () => {
  it("composes confirmations into their source order among refreshed roots", () => {
    const first = makeTask({ id: 1, title: "First" });
    const last = makeTask({ id: 4, title: "Last" });
    const rows = composeTaskListRows(
      [first, last],
      [transition(2, "Second", 1), transition(3, "Third", 2)],
    );

    expect(rows.map(row => row.kind === "task" ? row.task.title : row.transition.task.title))
      .toEqual(["First", "Second", "Third", "Last"]);
  });

  it("rebases later departures when an earlier detached row expires", () => {
    const earlier = transition(2, "Second", 1);
    const later = transition(3, "Third", 2);
    const entries = new Map([[2, earlier], [3, later]]);

    const rebased = removeTransitionAndRebase(entries, 2, new Set([1, 4]));

    expect(rebased.has(2)).toBe(false);
    expect(rebased.get(3)?.sourceIndex).toBe(1);
    expect(composeTaskListRows(
      [makeTask({ id: 1, title: "First" }), makeTask({ id: 4, title: "Last" })],
      [...rebased.values()],
    ).map(row => row.kind === "task" ? row.task.title : row.transition.task.title))
      .toEqual(["First", "Third", "Last"]);
  });

  it("does not shift later departures while the expiring task remains in the roots", () => {
    const earlier = transition(2, "Second", 1);
    const later = transition(3, "Third", 2);
    const rebased = removeTransitionAndRebase(
      new Map([[2, earlier], [3, later]]),
      2,
      new Set([1, 2, 4]),
    );

    expect(rebased.get(3)?.sourceIndex).toBe(2);
  });

  it("accounts for earlier detached rows when capturing a later source slot", () => {
    const earlier = transition(2, "Second", 1);
    expect(transitionSourceIndex(
      [1, 2, 3, 4],
      3,
      "outline",
      [earlier],
      new Set([1, 3, 4]),
    )).toBe(3);
  });
});
