import { describe, expect, it } from "vitest";
import type { Task } from "@machbar/shared";
import { makeTask } from "../test/fixtures";
import {
  beginTaskTransition,
  commitTaskTransition,
  emptyTaskTransitionLayout,
  reconcileTaskSections,
  rejectTaskTransition,
  releaseTaskTransition,
  taskTransitionDisplayChildren,
  taskTransitionNodeKey,
} from "./taskTransitionPresentation";

describe("task transition display layout", () => {
  it("keeps overlapping departures in their displayed sibling order", () => {
    const first = makeTask({ id: 501, title: "First" });
    const second = makeTask({ id: 502, title: "Second" });
    const third = makeTask({ id: 503, title: "Third" });
    let layout = reconcileTaskSections(emptyTaskTransitionLayout(), {
      source: { tasks: [first, second, third], readSettled: true, readFailed: false },
    });
    layout = beginTaskTransition(layout, "first", taskTransitionNodeKey(first.id), first, "complete", []);
    layout = beginTaskTransition(layout, "second", taskTransitionNodeKey(second.id), second, "cancel", []);
    layout = reconcileTaskSections(layout, {
      source: { tasks: [third], readSettled: true, readFailed: false },
    });

    const displayed = taskTransitionDisplayChildren(layout, "source", null, [third]);
    expect(displayed.map(item => "task" in item ? item.task.id : item.node.taskId)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("keeps the active row's source slot while unaffected rows adopt current order and values", () => {
    const active = makeTask({ id: 505, title: "Original active" });
    const sibling = makeTask({ id: 506, title: "Original sibling" });
    let layout = reconcileTaskSections(emptyTaskTransitionLayout(), {
      source: { tasks: [active, sibling], readSettled: true, readFailed: false },
    });
    layout = beginTaskTransition(layout, "active", taskTransitionNodeKey(active.id), active, "someday", []);
    layout = commitTaskTransition(layout, "active", 2, "someday");
    const freshActive = { ...active, status: "someday" as const, revision: 2 };
    const freshSibling = { ...sibling, title: "Fresh sibling", revision: 2 };
    layout = reconcileTaskSections(layout, {
      source: { tasks: [freshSibling, freshActive], readSettled: true, readFailed: false },
    });

    const displayed = taskTransitionDisplayChildren(layout, "source", null, [freshSibling, freshActive]);
    expect(displayed.map(item => "task" in item ? item.task.title : item.node.snapshot?.title)).toEqual([
      active.title,
      "Fresh sibling",
    ]);
    expect("task" in displayed[0]! ? displayed[0]!.task.status : undefined).toBe("someday");
  });

  it("keeps an active child under its departing parent and releases only the rejected parent hold", () => {
    const child = makeTask({ id: 511, parentTaskId: 510, title: "Child" });
    const parent = makeTask({ id: 510, title: "Parent", children: [child] });
    let layout = reconcileTaskSections(emptyTaskTransitionLayout(), {
      source: { tasks: [parent], readSettled: true, readFailed: false },
    });
    layout = beginTaskTransition(layout, "child", taskTransitionNodeKey(child.id), child, "complete", [
      { key: taskTransitionNodeKey(parent.id), title: parent.title },
    ]);
    layout = beginTaskTransition(layout, "parent", taskTransitionNodeKey(parent.id), parent, "cancel", []);
    layout = rejectTaskTransition(layout, "parent");
    layout = reconcileTaskSections(layout, {
      source: { tasks: [], readSettled: true, readFailed: false },
    });

    const displayed = taskTransitionDisplayChildren(layout, "source", null, []);
    expect(displayed).toHaveLength(1);
    const departure = displayed[0];
    if (!departure || !("node" in departure)) throw new Error("Expected retained parent shell");
    expect(departure.node.taskId).toBe(parent.id);
    expect(departure.node.snapshot).toBeUndefined();
    expect(departure.node.shellTitle).toBe(parent.title);
    expect(departure.children.map(node => node.taskId)).toEqual([child.id]);
  });

  it("suppresses a transferred destination while the source slot is held", () => {
    const task = makeTask({ id: 521, title: "Transferred" });
    let layout = reconcileTaskSections(emptyTaskTransitionLayout(), {
      source: { tasks: [task], readSettled: true, readFailed: false },
      destination: { tasks: [], readSettled: true, readFailed: false },
    });
    layout = beginTaskTransition(layout, "move", taskTransitionNodeKey(task.id), task, "actionable", []);
    layout = reconcileTaskSections(layout, {
      source: { tasks: [], readSettled: true, readFailed: false },
      destination: { tasks: [task], readSettled: true, readFailed: false },
    });

    expect(taskTransitionDisplayChildren(layout, "source", null, [])).toHaveLength(1);
    expect(taskTransitionDisplayChildren(layout, "destination", null, [task])).toHaveLength(0);
  });

  it("keeps a unique source occurrence through either ordered transfer-read sequence", () => {
    const task = makeTask({ id: 525, title: "Transferred" });
    const initial = reconcileTaskSections(emptyTaskTransitionLayout(), {
      source: { tasks: [task], readSettled: true, readFailed: false },
      destination: { tasks: [], readSettled: true, readFailed: false },
    });
    let active = beginTaskTransition(
      initial,
      "move",
      taskTransitionNodeKey(task.id),
      task,
      "actionable",
      [],
    );
    active = commitTaskTransition(active, "move", 2, "actionable");
    const destinationTask = { ...task, revision: 2, status: "actionable" as const };
    const sourceTask = Object.freeze({ ...task });
    const source = (tasks: Task[]) => ({
      tasks,
      readSettled: true,
      readFailed: false,
    });
    const visibleIds = (layout: ReturnType<typeof reconcileTaskSections>, sourceTasks: Task[], destinationTasks: Task[]) =>
      [
        ...taskTransitionDisplayChildren(layout, "source", null, sourceTasks),
        ...taskTransitionDisplayChildren(layout, "destination", null, destinationTasks),
      ].map(item => "task" in item ? item.task.id : item.node.taskId);

    for (const order of ["source-first", "destination-first"] as const) {
      let layout = active;
      if (order === "source-first") {
        layout = reconcileTaskSections(layout, {
          source: source([]),
          destination: source([]),
        });
        expect(visibleIds(layout, [], [])).toEqual([task.id]);
        layout = reconcileTaskSections(layout, {
          source: source([]),
          destination: source([destinationTask]),
        });
      } else {
        layout = reconcileTaskSections(layout, {
          source: source([sourceTask]),
          destination: source([destinationTask]),
        });
        expect(visibleIds(layout, [sourceTask], [destinationTask])).toEqual([task.id]);
        layout = reconcileTaskSections(layout, {
          source: source([]),
          destination: source([destinationTask]),
        });
      }

      expect(layout.sections.source?.rootKeys).toEqual([taskTransitionNodeKey(task.id)]);
      expect(visibleIds(layout, [], [destinationTask])).toEqual([task.id]);
      layout = reconcileTaskSections(releaseTaskTransition(layout, "move"), {
        source: source([]),
        destination: source([destinationTask]),
      });
      expect(taskTransitionDisplayChildren(layout, "source", null, [])).toHaveLength(0);
      expect(taskTransitionDisplayChildren(layout, "destination", null, [destinationTask])).toHaveLength(1);
    }
    expect(sourceTask).toEqual(task);
    expect(destinationTask).toEqual({ ...task, revision: 2, status: "actionable" });
  });

  it("keeps a revision watermark so later stale section data remains blocked", () => {
    const task = makeTask({ id: 531 });
    let layout = reconcileTaskSections(emptyTaskTransitionLayout(), {
      source: { tasks: [task], readSettled: true, readFailed: false },
    });
    layout = beginTaskTransition(layout, "complete", taskTransitionNodeKey(task.id), task, "complete", []);
    layout = commitTaskTransition(layout, "complete", 2, "done");
    layout = reconcileTaskSections(layout, {
      source: { tasks: [{ ...task, revision: 1 }], readSettled: false, readFailed: true },
      "other-section": { tasks: [], readSettled: true, readFailed: false },
    });

    expect(layout.staleGuards[task.id]).toBe(2);
  });

  it("allows a second transition after the fresh projection revalidates the committed revision", () => {
    const task = makeTask({ id: 541 });
    let layout = reconcileTaskSections(emptyTaskTransitionLayout(), {
      source: { tasks: [task], readSettled: true, readFailed: false },
    });
    layout = beginTaskTransition(layout, "first", taskTransitionNodeKey(task.id), task, "complete", []);
    layout = commitTaskTransition(layout, "first", 2, "done");
    layout = reconcileTaskSections(layout, {
      source: {
        tasks: [{ ...task, revision: 2, status: "done" }],
        readSettled: true,
        readFailed: false,
      },
    });
    layout = releaseTaskTransition(layout, "first");
    const second = beginTaskTransition(
      layout,
      "second",
      taskTransitionNodeKey(task.id),
      { ...task, revision: 2, status: "done" },
      "reopen",
      [],
    );

    expect(layout.staleGuards[task.id]).toBeUndefined();
    expect(second.operations.second).toBeDefined();
  });

  it("keeps the watermark after a failed read and rejects stale presentation start", () => {
    const task = makeTask({ id: 542 });
    let layout = reconcileTaskSections(emptyTaskTransitionLayout(), {
      source: { tasks: [task], readSettled: true, readFailed: false },
    });
    layout = beginTaskTransition(layout, "first", taskTransitionNodeKey(task.id), task, "complete", []);
    layout = commitTaskTransition(layout, "first", 2, "done");
    layout = reconcileTaskSections(layout, {
      source: { tasks: [task], readSettled: false, readFailed: true },
    });
    layout = releaseTaskTransition(layout, "first");
    const stale = beginTaskTransition(
      layout,
      "stale",
      taskTransitionNodeKey(task.id),
      task,
      "complete",
      [],
    );

    expect(layout.staleGuards[task.id]).toBe(2);
    expect(stale).toBe(layout);
    expect(stale.operations.stale).toBeUndefined();
  });

  it("blocks a stale action after failed revalidation, then accepts it after the fresh read", () => {
    const task = makeTask({ id: 543 });
    let layout = reconcileTaskSections(emptyTaskTransitionLayout(), {
      source: { tasks: [task], readSettled: true, readFailed: false },
    });
    layout = beginTaskTransition(layout, "first", taskTransitionNodeKey(task.id), task, "complete", []);
    layout = commitTaskTransition(layout, "first", 2, "done");
    layout = reconcileTaskSections(layout, {
      source: { tasks: [task], readSettled: false, readFailed: true },
    });
    layout = releaseTaskTransition(layout, "first");
    const stale = beginTaskTransition(
      layout,
      "stale-second",
      taskTransitionNodeKey(task.id),
      task,
      "complete",
      [],
    );
    expect(stale).toBe(layout);
    expect(layout.staleGuards[task.id]).toBe(2);

    layout = reconcileTaskSections(layout, {
      source: {
        tasks: [{ ...task, revision: 2, status: "done" }],
        readSettled: true,
        readFailed: false,
      },
    });
    const valid = beginTaskTransition(
      layout,
      "valid-second",
      taskTransitionNodeKey(task.id),
      { ...task, revision: 2, status: "done" },
      "reopen",
      [],
    );
    expect(layout.staleGuards[task.id]).toBeUndefined();
    expect(valid.operations["valid-second"]).toBeDefined();
  });

  it("retains pending and recurring operations across section transfers", () => {
    for (const task of [
      makeTask({ id: 551, status: "captured" }),
      makeTask({ id: 552, repeatAfterDays: 7 }),
    ]) {
      let layout = reconcileTaskSections(emptyTaskTransitionLayout(), {
        source: { tasks: [task], readSettled: true, readFailed: false },
        destination: { tasks: [], readSettled: true, readFailed: false },
      });
      const intent = task.repeatAfterDays === null ? "actionable" : "complete";
      layout = beginTaskTransition(layout, `move-${task.id}`, taskTransitionNodeKey(task.id), task, intent, []);
      expect(layout.operations[`move-${task.id}`]?.phase).toBe("pending");
      expect(layout.operations[`move-${task.id}`]?.recurringOccurrence).toBe(
        task.repeatAfterDays !== null,
      );
      const destinationTask = { ...task, status: "actionable" as const };
      layout = reconcileTaskSections(layout, {
        source: { tasks: [], readSettled: true, readFailed: false },
        destination: {
          tasks: [destinationTask],
          readSettled: true,
          readFailed: false,
        },
      });
      expect(layout.operations[`move-${task.id}`]?.phase).toBe("pending");
      const visibleBeforeCommit = [
        ...taskTransitionDisplayChildren(layout, "source", null, []),
        ...taskTransitionDisplayChildren(layout, "destination", null, [destinationTask]),
      ];
      expect(visibleBeforeCommit.map(item => "task" in item ? item.task.id : item.node.taskId))
        .toEqual([task.id]);

      layout = commitTaskTransition(layout, `move-${task.id}`, 2, "actionable");
      layout = reconcileTaskSections(layout, {
        source: { tasks: [], readSettled: true, readFailed: false },
        destination: {
          tasks: [{ ...destinationTask, revision: 2 }],
          readSettled: true,
          readFailed: false,
        },
      });

      expect(taskTransitionDisplayChildren(layout, "source", null, [])).toHaveLength(1);
      expect(taskTransitionDisplayChildren(layout, "destination", null, [
        { ...destinationTask, revision: 2 },
      ])).toHaveLength(0);
      expect(taskTransitionDisplayChildren(
        reconcileTaskSections(releaseTaskTransition(layout, `move-${task.id}`), {
          source: { tasks: [], readSettled: true, readFailed: false },
          destination: {
            tasks: [{ ...destinationTask, revision: 2 }],
            readSettled: true,
            readFailed: false,
          },
        }),
        "destination",
        null,
        [{ ...destinationTask, revision: 2 }],
      )).toHaveLength(1);
    }
  });
});
