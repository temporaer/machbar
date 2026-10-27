import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Task } from "@machbar/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "./locale";
import { RefreshProvider } from "./refresh";
import { TaskActionsProvider, useTaskActions } from "./useTaskActions";
import { useRetainedPlacement } from "./useRetainedPlacement";
import { applyDescendantTerminalOutcome, flattenTasks } from "./taskHelpers";
import { RETENTION_MS } from "./useRetainedMutations";
import { api } from "./api";
import { makeTask } from "../test/fixtures";

vi.mock("./api", () => ({ api: { updateTask: vi.fn() } }));
const mockedApi = vi.mocked(api, true);
function wrapper({ children }: { children: ReactNode }) {
  return <LocaleProvider initialLocale="de"><RefreshProvider><TaskActionsProvider>{children}</TaskActionsProvider></RefreshProvider></LocaleProvider>;
}

type Event = "save" | "refresh" | "interact";
// All six causal orders, deterministic and independent of scheduling/CPU speed.
const orders: Event[][] = [
  ["save", "refresh", "interact"], ["save", "interact", "refresh"],
  ["refresh", "save", "interact"], ["refresh", "interact", "save"],
  ["interact", "save", "refresh"], ["interact", "refresh", "save"],
];
const cases = orders.flatMap(order => [2, 3].map(interactedId => ({ label: order.join(" → "), order, interactedId })));
type Buckets = { today: Task[]; other: Task[] };

function assertUnique(buckets: Buckets) {
  const rows = Object.values(buckets).flatMap(flattenTasks);
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  return rows;
}

describe("task save/refresh/interaction sequence contract", () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it.each(cases)("$label, interacting with task $interactedId", async ({ order, interactedId }) => {
    vi.useFakeTimers();
    const child = makeTask({ id: 2, title: "Existing child", blocked: true });
    const attached = makeTask({ id: 3, title: "Initially separate" });
    const parent = makeTask({ id: 1, title: "Original", blocked: true, children: [child] });
    const confirmed = { ...parent, title: "Renamed", revision: 2, children: [] };
    const freshChild = { ...child, blocked: false, futureDerived: "fresh" };
    const freshParent = { ...confirmed, blocked: false, futureDerived: "parent fresh", children: [freshChild, { ...attached, parentTaskId: parent.id }] };
    const initial: Buckets = { today: [parent, attached], other: [] };
    const refreshed: Buckets = { today: [], other: [freshParent] };
    let resolveSave!: (value: Task) => void;
    mockedApi.updateTask.mockImplementation(() => new Promise<Task>(resolve => { resolveSave = resolve; }));
    const { result, rerender } = renderHook(({ buckets }: { buckets: Buckets }) => {
      const actions = useTaskActions(Object.values(buckets).flatMap(flattenTasks));
      const displayed = useRetainedPlacement(buckets, actions.holdingIds, actions.projectTask, "same-view", applyDescendantTerminalOutcome);
      return { actions, displayed };
    }, { wrapper, initialProps: { buckets: initial } });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.actions.update(parent, { title: "Renamed" }); });
    expect(result.current.actions.isPending(parent.id)).toBe(true);
    expect(result.current.displayed.today[0]!.title).toBe("Renamed");
    let closeInteraction!: () => void;
    for (const event of order) {
      if (event === "save") await act(async () => { resolveSave(confirmed); await pending; });
      if (event === "refresh") rerender({ buckets: refreshed });
      if (event === "interact") act(() => { closeInteraction = result.current.actions.pauseRetention(interactedId); });
      const rows = assertUnique(result.current.displayed);
      expect(rows.map(row => row.id).sort()).toEqual([1, 2, 3]);
      expect(result.current.displayed.today[0]!.id).toBe(parent.id);
      expect(result.current.displayed.today[0]!.title).toBe("Renamed");
    }
    // A stale response after fresh data must not restore stale equal-revision
    // children, and a confirmed response with children:[] must not lose them.
    const rows = assertUnique(result.current.displayed);
    expect(rows.find(row => row.id === 1)).toMatchObject({ blocked: false, futureDerived: "parent fresh" });
    expect(rows.find(row => row.id === 2)).toMatchObject({ blocked: false, futureDerived: "fresh" });
    expect(result.current.displayed.today[0]!.children.map(row => row.id)).toEqual([2, 3]);
    await act(async () => { await vi.advanceTimersByTimeAsync(RETENTION_MS * 2); });
    expect(result.current.actions.holdingIds.has(parent.id)).toBe(true);
    expect(result.current.displayed.today[0]!.id).toBe(parent.id);
    act(() => closeInteraction());
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(result.current.actions.holdingIds.has(parent.id)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.actions.holdingIds.has(parent.id)).toBe(false);
    expect(result.current.displayed).toEqual(refreshed);
    assertUnique(result.current.displayed);
  });

  it.each(["network", "stale"])("rolls back a %s failure while preserving a newer refresh", async failure => {
    vi.useFakeTimers();
    const original = makeTask({ id: 1, title: "Original" });
    const fresh = { ...original, revision: 2, title: "Changed elsewhere" };
    let rejectSave!: (error: Error) => void;
    mockedApi.updateTask.mockImplementation(() => new Promise((_, reject) => { rejectSave = reject; }));
    const { result, rerender } = renderHook(({ tasks }: { tasks: Task[] }) => {
      const actions = useTaskActions(tasks);
      return { actions, task: actions.projectTask(tasks[0]!) };
    }, { wrapper, initialProps: { tasks: [original] } });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.actions.update(original, { title: "Authored edit" }); });
    expect(result.current.task.title).toBe("Authored edit");
    rerender({ tasks: [fresh] });
    await act(async () => {
      rejectSave(failure === "stale" ? Object.assign(new Error("Conflict"), { name: "ApiError", code: "stale_write_conflict" }) : new Error("Network failed"));
      await pending;
    });
    expect(result.current.actions.isPending(1)).toBe(false);
    expect(result.current.actions.holdingIds.has(1)).toBe(false);
    expect(result.current.task).toEqual(fresh);
    expect(result.current.actions.errors[1]).toBeTruthy();
  });
});
