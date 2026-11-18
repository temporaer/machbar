import { describe, expect, it } from "vitest";
import { makeTask } from "../test/fixtures";
import {
  beginTaskTransition,
  commitTaskTransition,
  commitTaskTransition,
  emptyTaskTransitionLayout,
  reconcileTaskSection,
  rejectTaskTransition,
  taskTransitionDisplayChildren,
  taskTransitionNodeKey,
} from "./taskTransitionPresentation";

describe("task transition display layout", () => {
  it("keeps overlapping departures in their displayed sibling order", () => {
    const first = makeTask({ id: 501, title: "First" });
    const second = makeTask({ id: 502, title: "Second" });
    const third = makeTask({ id: 503, title: "Third" });
    let layout = reconcileTaskSection(emptyTaskTransitionLayout(), "source", [first, second, third], true);
    layout = beginTaskTransition(layout, "first", taskTransitionNodeKey(first.id), first, "complete", []);
    layout = beginTaskTransition(layout, "second", taskTransitionNodeKey(second.id), second, "cancel", []);
    layout = reconcileTaskSection(layout, "source", [third], true);

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
    let layout = reconcileTaskSection(emptyTaskTransitionLayout(), "source", [active, sibling], true);
    layout = beginTaskTransition(layout, "active", taskTransitionNodeKey(active.id), active, "someday", []);
    layout = commitTaskTransition(layout, "active", 2, "someday");
    const freshActive = { ...active, status: "someday" as const, revision: 2 };
    const freshSibling = { ...sibling, title: "Fresh sibling", revision: 2 };
    layout = reconcileTaskSection(layout, "source", [freshSibling, freshActive], true);

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
    let layout = reconcileTaskSection(emptyTaskTransitionLayout(), "source", [parent], true);
    layout = beginTaskTransition(layout, "child", taskTransitionNodeKey(child.id), child, "complete", [
      { key: taskTransitionNodeKey(parent.id), title: parent.title },
    ]);
    layout = beginTaskTransition(layout, "parent", taskTransitionNodeKey(parent.id), parent, "cancel", []);
    layout = rejectTaskTransition(layout, "parent");
    layout = reconcileTaskSection(layout, "source", [], true);

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
    let layout = reconcileTaskSection(emptyTaskTransitionLayout(), "source", [task], true);
    layout = reconcileTaskSection(layout, "destination", [], true);
    layout = beginTaskTransition(layout, "move", taskTransitionNodeKey(task.id), task, "actionable", []);
    layout = reconcileTaskSection(layout, "source", [], true);
    layout = reconcileTaskSection(layout, "destination", [task], true);

    expect(taskTransitionDisplayChildren(layout, "source", null, [])).toHaveLength(1);
    expect(taskTransitionDisplayChildren(layout, "destination", null, [task])).toHaveLength(0);
  });

  it("keeps a revision watermark so later stale section data remains blocked", () => {
    const task = makeTask({ id: 531 });
    let layout = reconcileTaskSection(emptyTaskTransitionLayout(), "source", [task], true);
    layout = beginTaskTransition(layout, "complete", taskTransitionNodeKey(task.id), task, "complete", []);
    layout = commitTaskTransition(layout, "complete", 2, "done");
    layout = reconcileTaskSection(
      layout,
      "other-section",
      [{ ...task, revision: 2, status: "done" }],
      true,
    );
    layout = reconcileTaskSection(layout, "source", [{ ...task, revision: 1 }], false);

    expect(layout.staleGuards[task.id]).toBe(2);
  });
});
