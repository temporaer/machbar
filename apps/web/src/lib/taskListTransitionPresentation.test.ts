import { describe, expect, it } from "vitest";
import { makeTask } from "../test/fixtures";
import {
  composeTaskListRows,
  findTaskListPosition,
  suppressedTransitionTaskIds,
  type TaskListTransitionEntry,
} from "./taskListTransitionPresentation";

function transition(
  task: ReturnType<typeof makeTask>,
  sourcePath: TaskListTransitionEntry["sourcePath"],
  sourceOutlineId = "origin",
): TaskListTransitionEntry {
  return {
    task,
    event: {
      taskId: task.id,
      targetStatus: task.status === "cancelled" ? "cancelled" : "done",
      occurrence: false,
      phase: "success",
      sourceRevision: 1,
      resultStatus: task.status === "cancelled" ? "cancelled" : "done",
      resultRevision: 2,
    },
    sourceOutlineId,
    sourcePath,
  };
}

describe("task list transition presentation", () => {
  it("keeps confirmations at their source slots when sibling rows remain", () => {
    const first = makeTask({ id: 1, title: "First" });
    const second = makeTask({ id: 2, title: "Second", status: "done" });
    const third = makeTask({ id: 3, title: "Third", status: "done" });
    const last = makeTask({ id: 4, title: "Last" });
    const originalRoots = [first, makeTask({ ...second, status: "actionable" }), makeTask({ ...third, status: "actionable" }), last];
    const paths = [second.id, third.id].map(id => findTaskListPosition(originalRoots, id));
    const transitions = [
      transition(second, paths[0] ?? null),
      transition(third, paths[1] ?? null),
    ];

    const rows = composeTaskListRows([first, last], transitions, "origin");

    expect(rows.map(row => row.kind === "task" ? row.task.title : row.transition.task.title))
      .toEqual(["First", "Second", "Third", "Last"]);
  });

  it("keeps the original source slot when its section has no authoritative roots", () => {
    const before = makeTask({ id: 11, title: "Before" });
    const moved = makeTask({ id: 12, title: "Moved", status: "done" });
    const after = makeTask({ id: 13, title: "After" });
    const path = findTaskListPosition([before, makeTask({ ...moved, status: "actionable" }), after], moved.id);

    const rows = composeTaskListRows([], [transition(moved, path)], "origin");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "transition" && rows[0].transition.task.title).toBe("Moved");
  });

  it("naturally restores the right order when earlier confirmations expire first", () => {
    const first = makeTask({ id: 21, title: "First" });
    const second = makeTask({ id: 22, title: "Second", status: "done" });
    const third = makeTask({ id: 23, title: "Third", status: "done" });
    const last = makeTask({ id: 24, title: "Last" });
    const originalRoots = [first, makeTask({ ...second, status: "actionable" }), makeTask({ ...third, status: "actionable" }), last];
    const secondPath = findTaskListPosition(originalRoots, second.id);
    const thirdPath = findTaskListPosition(originalRoots, third.id);
    const laterTransition = transition(third, thirdPath);

    const rows = composeTaskListRows(
      [first, last],
      [laterTransition],
      "origin",
    );

    expect(rows.map(row => row.kind === "task" ? row.task.title : row.transition.task.title))
      .toEqual(["First", "Third", "Last"]);
    expect(secondPath?.[0]?.siblingIds).toEqual([21, 22, 23, 24]);
  });

  it("places a nested confirmation under its original parent, never among roots", () => {
    const firstChild = makeTask({ id: 31, title: "First child", parentTaskId: 30 });
    const targetChild = makeTask({ id: 32, title: "Nested completion", parentTaskId: 30, status: "done" });
    const parent = makeTask({
      id: 30,
      title: "Parent",
      children: [firstChild, makeTask({ ...targetChild, status: "actionable" })],
    });
    const path = findTaskListPosition([parent], targetChild.id);
    const nestedTransition = transition(targetChild, path);
    const rootRows = composeTaskListRows([parent], [nestedTransition], "origin");
    const parentRow = rootRows[0];

    expect(rootRows.map(row => row.kind)).toEqual(["task"]);
    expect(parentRow?.kind).toBe("task");
    if (parentRow?.kind !== "task") return;
    const childRows = composeTaskListRows(
      [],
      parentRow.childTransitions,
      "origin",
      parent.id,
    );
    expect(childRows).toHaveLength(1);
    expect(childRows[0]?.kind === "transition" && childRows[0].transition.task.title)
      .toBe("Nested completion");
  });

  it("suppresses a transferred destination copy only while its source confirmation is active", () => {
    const task = makeTask({ id: 41, title: "Transferred", status: "done" });
    const sourcePath = findTaskListPosition([makeTask({ ...task, status: "actionable" })], task.id);
    const active = transition(task, sourcePath);
    const transitions = [active];
    const suppressed = suppressedTransitionTaskIds(transitions, "destination");

    expect(composeTaskListRows([task], transitions, "destination", null, suppressed)).toEqual([]);
    expect(composeTaskListRows([task], [], "destination")).toMatchObject([
      { kind: "task", task: { id: task.id } },
    ]);
  });
});
