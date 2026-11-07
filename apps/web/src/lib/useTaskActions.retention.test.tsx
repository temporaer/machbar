import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "./locale";
import { RefreshProvider } from "./refresh";
import { TaskActionsProvider, useTaskActions } from "./useTaskActions";
import { useRetentionInteraction } from "./useRetentionInteraction";
import { api } from "./api";
import { makeTask } from "../test/fixtures";

vi.mock("./api", () => ({ api: {
  completeTask: vi.fn(), updateTask: vi.fn(), makeTaskAction: vi.fn(),
  setExternalWait: vi.fn(), resolveExternalWait: vi.fn(), followUpExternalWait: vi.fn(),
} }));
const mockedApi = vi.mocked(api, true);
function wrapper({ children }: { children: ReactNode }) {
  return <LocaleProvider initialLocale="de"><RefreshProvider><TaskActionsProvider>{children}</TaskActionsProvider></RefreshProvider></LocaleProvider>;
}

describe("task placement interaction ownership", () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it.each(["membership", "revision"] as const)("preserves authoritative child %s beneath a newer confirmed scalar receipt after visual release", async boundary => {
    const oldChild = makeTask({ id: 90, revision: 2, status: "done" });
    const parent = makeTask({ id: 1, children: [oldChild] });
    const confirmed = { ...parent, priority: 1, revision: 2 };
    mockedApi.updateTask.mockResolvedValue(confirmed);
    const { result } = renderHook(() => useTaskActions(), { wrapper });
    await act(async () => { await result.current.update(parent, { priority: 1 }); });
    act(() => result.current.release(parent.id));
    const child = boundary === "membership" ? makeTask({ id: 91 }) : { ...oldChild, revision: 3, status: "actionable" as const };
    const projected = result.current.projectTask({ ...parent, children: [child] });
    expect(projected.revision).toBe(2);
    expect(projected.priority).toBe(1);
    expect(projected.children).toEqual([child]);
  });

  it.each(["set", "resolve", "follow-up", "promote"] as const)("shares the accepted %s command receipt without visual retention", async command => {
    const task = makeTask({ id: 1, kind: command === "promote" ? "reference" : "action", externalWait: { waitingFor: "Original supplier" } });
    const confirmed = { ...task, kind: "action" as const, revision: 2, externalWait: command === "resolve" ? null : { waitingFor: "Confirmed supplier" } };
    mockedApi.setExternalWait.mockResolvedValue(confirmed);
    mockedApi.resolveExternalWait.mockResolvedValue(confirmed);
    mockedApi.followUpExternalWait.mockResolvedValue(confirmed);
    mockedApi.makeTaskAction.mockResolvedValue(confirmed);
    const { result } = renderHook(() => useTaskActions([task]), { wrapper });
    await act(async () => {
      if (command === "set") await result.current.setExternalWait(task, { waitingFor: "Confirmed supplier" });
      else if (command === "resolve") await result.current.resolveExternalWait(task);
      else if (command === "follow-up") await result.current.followUpExternalWait(task, { action: "continue", content: "Called supplier", waitingFor: "Confirmed supplier" });
      else await result.current.makeAction(task);
    });
    expect(result.current.projectTask(task)).toBe(confirmed);
    expect(result.current.retained.has(task.id)).toBe(false);
    expect(result.current.holdingIds.has(task.id)).toBe(false);
    const fresh = { ...confirmed, blocked: true, executable: false };
    expect(result.current.projectTask(fresh)).toBe(fresh);
  });

  it.each([false, true])("protects the retained ancestor when descendant interaction starts before save: %s", async initiallyOpen => {
    vi.useFakeTimers();
    const grandchild = makeTask({ id: 3 });
    const child = makeTask({ id: 2, children: [grandchild] });
    const parent = makeTask({ id: 1, children: [child] });
    // The displayed subtree is retained even if the response omits descendants.
    mockedApi.completeTask.mockResolvedValue({ ...parent, status: "done", revision: 2, children: [] });
    const { result, rerender } = renderHook(({ open }) => {
      const actions = useTaskActions();
      useRetentionInteraction(grandchild.id, actions.pauseRetention, open);
      return actions;
    }, { wrapper, initialProps: { open: initiallyOpen } });
    await act(async () => { await result.current.complete(parent, "leave_open"); });
    rerender({ open: true });
    const confirmed = { ...parent, status: "done" as const, revision: 2, children: [] };
    mockedApi.updateTask.mockResolvedValue({ ...confirmed, title: "Edited again", revision: 3 });
    await act(async () => { await result.current.update(confirmed, { title: "Edited again" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(result.current.holdingIds.has(parent.id)).toBe(true);
    rerender({ open: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(result.current.holdingIds.has(parent.id)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.holdingIds.has(parent.id)).toBe(false);
  });

  it("keeps the retained parent while its child-policy decision is pending", async () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 1, status: "captured", children: [makeTask({ id: 2 })] });
    const clarified = { ...task, status: "actionable" as const, revision: 2 };
    mockedApi.updateTask.mockResolvedValue(clarified);
    const { result } = renderHook(() => useTaskActions(), { wrapper });
    await act(async () => { await result.current.update(task, { status: "actionable" }); });
    act(() => result.current.requestToggle(clarified));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(result.current.pendingTask?.id).toBe(task.id);
    expect(result.current.holdingIds.has(task.id)).toBe(true);
    act(() => result.current.cancelPrompt());
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(result.current.holdingIds.has(task.id)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.holdingIds.has(task.id)).toBe(false);
  });
  it.each([false, true])("adds new placement owners to existing descendant interactions: already open %s", async alreadyOpen => {
    vi.useFakeTimers();
    const removed = makeTask({ id: 2 });
    const attached = makeTask({ id: 3 });
    const parent = makeTask({ id: 1, children: [removed] });
    const renamed = { ...parent, title: "Edited", revision: 2 };
    mockedApi.updateTask.mockResolvedValue(renamed);
    const { result, rerender } = renderHook(({ open }) => {
      const actions = useTaskActions();
      useRetentionInteraction(attached.id, actions.pauseRetention, open);
      return actions;
    }, { wrapper, initialProps: { open: alreadyOpen } });
    await act(async () => { await result.current.update(parent, { title: renamed.title }); });
    act(() => result.current.observeTasks([{ ...renamed, children: [attached] }]));
    rerender({ open: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(result.current.holdingIds.has(parent.id)).toBe(true);
    let closeOldPath!: () => void;
    act(() => { closeOldPath = result.current.pauseRetention(removed.id); });
    rerender({ open: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(result.current.holdingIds.has(parent.id)).toBe(true);
    act(() => closeOldPath());
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(result.current.holdingIds.has(parent.id)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.holdingIds.has(parent.id)).toBe(false);
  });

});
