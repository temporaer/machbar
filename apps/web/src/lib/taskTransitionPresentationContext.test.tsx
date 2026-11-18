import { StrictMode, useLayoutEffect, useState, type MutableRefObject } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@machbar/shared";
import { makeTask } from "../test/fixtures";
import {
  TaskTransitionPresentationProvider,
  useTaskTransitionPresentation,
} from "./taskTransitionPresentationContext";
import {
  TASK_TRANSITION_CONFIRMATION_MS,
  taskTransitionDisplayChildren,
  type TaskTransitionLayout,
  type TaskTransitionOrigin,
} from "./taskTransitionPresentation";

const task = makeTask({ id: 601, title: "Origin task" });

function OriginProbe({ origins }: { origins: Map<string, TaskTransitionOrigin> }) {
  const presentation = useTaskTransitionPresentation();
  useLayoutEffect(() => {
    const origin = presentation?.origin("source", task);
    if (presentation && origin) origins.set(presentation.viewId, origin);
  }, [presentation, origins]);
  return <output data-testid="operations">{Object.keys(presentation?.layout.operations ?? {}).join(",")}</output>;
}

function Harness({ origins }: { origins: Map<string, TaskTransitionOrigin> }) {
  const [identityKey, setIdentityKey] = useState("today:mine:1");
  return (
    <>
      <button onClick={() => setIdentityKey("today:all:1")}>Change selection</button>
      <TaskTransitionPresentationProvider
        identityKey={identityKey}
        projection={{ source: { tasks: [task], readSettled: true, readFailed: false } }}
      >
        <OriginProbe origins={origins} />
      </TaskTransitionPresentationProvider>
    </>
  );
}

function StrictHarness({ origins }: { origins: Map<string, TaskTransitionOrigin> }) {
  return (
    <StrictMode>
      <TaskTransitionPresentationProvider
        identityKey="today:mine:1"
        projection={{ source: { tasks: [task], readSettled: true, readFailed: false } }}
      >
        <OriginProbe origins={origins} />
      </TaskTransitionPresentationProvider>
    </StrictMode>
  );
}

function TimedTransitions({
  origins,
  readLayout,
  removeProjection,
}: {
  origins: MutableRefObject<Record<number, TaskTransitionOrigin>>;
  readLayout(layout: TaskTransitionLayout): void;
  removeProjection(): void;
}) {
  const presentation = useTaskTransitionPresentation();
  const child = makeTask({ id: 602, parentTaskId: 603, title: "Child" });
  const parent = makeTask({ id: 603, title: "Parent", children: [child] });
  const sibling = makeTask({ id: 604, title: "Sibling" });
  useLayoutEffect(() => {
    if (!presentation) return;
    const parentOrigin = presentation.origin("source", parent);
    const childOrigin = presentation.origin("source", child);
    const siblingOrigin = presentation.origin("source", sibling);
    if (parentOrigin && childOrigin && siblingOrigin) {
      origins.current = {
        [parent.id]: parentOrigin,
        [child.id]: childOrigin,
        [sibling.id]: siblingOrigin,
      };
    }
  }, [child, origins, parent, presentation, sibling]);
  if (presentation) readLayout(presentation.layout);
  const run = (task: typeof parent, intent: "complete" | "cancel") => {
    const origin = origins.current[task.id];
    const token = `transition-${task.id}`;
    if (origin?.begin(token, task, intent) !== "started") return;
    origin.commit(token, task.revision + 1, intent === "complete" ? "done" : "cancelled");
    origin.settled(token, false);
  };
  return (
    <>
      <button onClick={() => run(child, "complete")}>Complete child</button>
      <button onClick={() => run(sibling, "complete")}>Complete sibling</button>
      <button onClick={() => run(parent, "cancel")}>Cancel parent</button>
      <button onClick={removeProjection}>Remove projected rows</button>
    </>
  );
}

describe("task transition presentation owner", () => {
  afterEach(() => vi.useRealTimers());

  it("retires the old origin on selection change without replacing surrounding controls", async () => {
    const origins = new Map<string, TaskTransitionOrigin>();
    render(<Harness origins={origins} />);
    await waitFor(() => expect(origins.size).toBe(1));
    const [oldOrigin] = origins.values();
    expect(oldOrigin?.begin("delayed-response", task, "complete")).toBe("started");
    const control = screen.getByRole("button", { name: "Change selection" });

    await act(async () => control.click());
    await waitFor(() => expect(origins.size).toBe(2));

    expect(screen.getByRole("button", { name: "Change selection" })).toBe(control);
    oldOrigin?.commit("delayed-response", task.revision + 1, "done");
    oldOrigin?.settled("delayed-response", false);
    expect(screen.getByTestId("operations")).toHaveTextContent("");
    expect(oldOrigin?.begin("late", task, "complete")).toBe("unavailable");
  });

  it("can start an origin after StrictMode effect replay without changing the projection", async () => {
    const origins = new Map<string, TaskTransitionOrigin>();
    render(<StrictHarness origins={origins} />);
    await waitFor(() => expect(origins.size).toBeGreaterThan(0));
    const origin = [...origins.values()].at(-1)!;

    let result: ReturnType<TaskTransitionOrigin["begin"]> = "unavailable";
    act(() => { result = origin.begin("strict-replay", task, "complete"); });
    expect(result).toBe("started");
    expect(screen.getByTestId("operations")).toHaveTextContent("strict-replay");
  });

  it("expires overlapping child, sibling, and parent holds on their own deadlines", async () => {
    vi.useFakeTimers();
    const origins = { current: {} as Record<number, TaskTransitionOrigin> };
    let layout: TaskTransitionLayout | undefined;
    const child = makeTask({ id: 602, parentTaskId: 603, title: "Child" });
    const parent = makeTask({ id: 603, title: "Parent", children: [child] });
    const sibling = makeTask({ id: 604, title: "Sibling" });
    function OverlapHarness() {
      const [tasks, setTasks] = useState([parent, sibling]);
      return (
        <TaskTransitionPresentationProvider
          identityKey="today:mine:1"
          projection={{ source: { tasks, readSettled: true, readFailed: false } }}
        >
          <TimedTransitions
            origins={origins}
            readLayout={next => { layout = next; }}
            removeProjection={() => setTasks([])}
          />
        </TaskTransitionPresentationProvider>
      );
    }
    render(
      <OverlapHarness />,
    );

    await act(async () => {});
    expect(origins.current[child.id]).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Complete child" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent.click(screen.getByRole("button", { name: "Complete sibling" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel parent" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove projected rows" }));
    expect(layout?.sections.source?.rootKeys).toEqual([
      "task:603",
      "task:604",
    ]);
    expect(taskTransitionDisplayChildren(layout!, "source", null, []).map(item =>
      "task" in item ? item.task.id : item.node.taskId,
    )).toEqual([parent.id, sibling.id]);
    const parentBranch = taskTransitionDisplayChildren(layout!, "source", null, [])[0];
    expect(parentBranch && "children" in parentBranch ? parentBranch.children.map(node => node.taskId) : [])
      .toEqual([child.id]);

    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_TRANSITION_CONFIRMATION_MS - 1_000); });
    expect(layout?.operations["transition-602"]).toBeUndefined();
    expect(layout?.operations["transition-604"]).toBeDefined();
    expect(layout?.operations["transition-603"]).toBeDefined();
    expect(taskTransitionDisplayChildren(layout!, "source", null, []).map(item =>
      "task" in item ? item.task.id : item.node.taskId,
    )).toContain(parent.id);
    const retainedParent = taskTransitionDisplayChildren(layout!, "source", null, [])[0];
    expect(retainedParent && "children" in retainedParent ? retainedParent.children : [])
      .toHaveLength(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(layout?.operations["transition-604"]).toBeUndefined();
    expect(layout?.operations["transition-603"]).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(layout?.operations).toEqual({});
    expect(taskTransitionDisplayChildren(layout!, "source", null, [])).toHaveLength(0);
    vi.useRealTimers();
  });
});
