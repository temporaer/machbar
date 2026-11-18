import { describe, expect, it } from "vitest";
import { makeTask } from "../test/fixtures";
import {
  composeTaskListRows,
  composeTaskListPresentation,
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

    expect(rows.map(row => row.kind === "task" ? row.task.title : row.kind === "ancestor" ? row.title : row.transition.task.title))
      .toEqual(["First", "Second", "Third", "Last"]);
  });

  it("orders sequential departures by sibling identity across refreshed snapshots", () => {
    const first = makeTask({ id: 20, title: "First completed" });
    const second = makeTask({ id: 10, title: "Second completed" });
    const remaining = makeTask({ id: 30, title: "Remaining" });
    const firstPath = findTaskListPosition([first, second, remaining], first.id);
    const secondPath = findTaskListPosition([second, remaining], second.id);

    const rows = composeTaskListRows(
      [remaining],
      [transition(first, firstPath), transition(second, secondPath)],
      "origin",
    );

    expect(rows.map(row =>
      row.kind === "task" ? row.task.title : row.kind === "ancestor" ? row.title : row.transition.task.title,
    )).toEqual(["First completed", "Second completed", "Remaining"]);
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

    expect(rows.map(row => row.kind === "task" ? row.task.title : row.kind === "ancestor" ? row.title : row.transition.task.title))
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

  it("renders a nested completion under inert missing ancestors when its root leaves", () => {
    const target = makeTask({ id: 53, title: "Nested completion", parentTaskId: 52, status: "done" });
    const intermediate = makeTask({
      id: 52,
      title: "Missing intermediate",
      parentTaskId: 51,
      children: [makeTask({ ...target, status: "actionable" })],
    });
    const parent = makeTask({
      id: 51,
      title: "Missing parent",
      children: [intermediate],
    });
    const path = findTaskListPosition([parent], target.id);
    const entry = transition(target, path);

    const result = composeTaskListPresentation([], [entry], "origin", new Set(["origin"]));
    const root = result.rows[0];

    expect(root).toMatchObject({
      kind: "ancestor",
      title: parent.title,
      children: [{
        kind: "ancestor",
        title: intermediate.title,
        children: [{ kind: "transition", transition: { task: { title: target.title } } }],
      }],
    });
    expect(composeTaskListPresentation([], [entry], "destination", new Set(["origin"])).rows).toMatchObject([]);
  });

  it("nests a child's confirmation under its departing parent instead of duplicating the parent", () => {
    const child = makeTask({ id: 62, title: "Completed child", status: "done", parentTaskId: 61 });
    const parent = makeTask({
      id: 61,
      title: "Completed parent",
      status: "done",
    });
    const originalTree = [makeTask({
      id: parent.id,
      title: parent.title,
      children: [makeTask({ ...child, status: "actionable" })],
    })];

    const rows = composeTaskListRows([], [
      transition(parent, findTaskListPosition(originalTree, parent.id)),
      transition(child, findTaskListPosition(originalTree, child.id)),
    ], "origin");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "transition",
      transition: { task: { id: parent.id } },
      children: [{
        kind: "transition",
        transition: { task: { id: child.id } },
      }],
    });
  });

  it("anchors missing ancestors among remaining source rows and reveals destination if source is unavailable", () => {
    const parent = makeTask({ id: 55, title: "Omitted parent", children: [
      makeTask({ id: 56, title: "Omitted child", parentTaskId: 55, status: "actionable" }),
    ] });
    const child = makeTask({ id: 56, title: "Omitted child", parentTaskId: 55, status: "done" });
    const after = makeTask({ id: 57, title: "Remaining source" });
    const entry = transition(child, findTaskListPosition([parent, after], child.id));
    const retained = composeTaskListPresentation([after], [entry], "origin", new Set(["origin"]));

    expect(retained.rows.map(row => row.kind === "task" ? row.task.title : row.kind === "ancestor" ? row.title : row.transition.task.title))
      .toEqual([parent.title, after.title]);
    expect(composeTaskListPresentation([child], [entry], "destination", new Set()).rows)
      .toMatchObject([{ kind: "task", task: { title: child.title } }]);
  });

  it("does not suppress the only destination row when the origin is unrenderable and restores it after expiry", () => {
    const task = makeTask({ id: 41, title: "Transferred", status: "done" });
    const sourcePath = findTaskListPosition([makeTask({ ...task, status: "actionable" })], task.id);
    const active = transition(task, sourcePath);
    const transitions = [active];
    const suppressed = suppressedTransitionTaskIds(transitions, "destination", new Set());

    expect(composeTaskListRows([task], transitions, "destination", null, suppressed)).toMatchObject([
      { kind: "task", task: { id: task.id } },
    ]);
    expect(composeTaskListPresentation([task], transitions, "destination", new Set(["origin"])).rows).toEqual([]);
    expect(composeTaskListRows([task], [], "destination")).toMatchObject([
      { kind: "task", task: { id: task.id } },
    ]);
  });

  it.each([
    ["pending", false],
    ["success", true],
  ] as const)("suppresses an active %s transition in a registered destination", (phase, occurrence) => {
    const task = makeTask({ id: 71, title: "Moving task", status: "actionable" });
    const sourcePath = findTaskListPosition([task], task.id);
    const entry: TaskListTransitionEntry = {
      ...transition(task, sourcePath),
      event: {
        ...transition(task, sourcePath).event,
        phase,
        occurrence,
        targetStatus: occurrence ? "actionable" : "done",
        resultStatus: occurrence ? "actionable" : "done",
      },
    };

    expect(suppressedTransitionTaskIds([entry], "destination", new Set(["origin"])))
      .toEqual(new Set([task.id]));
    expect(composeTaskListPresentation(
      [task],
      [entry],
      "destination",
      new Set(["origin"]),
    ).rows).toEqual([]);
  });
});
