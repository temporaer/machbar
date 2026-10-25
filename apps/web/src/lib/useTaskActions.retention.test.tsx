import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "./locale";
import { RefreshProvider } from "./refresh";
import { TaskActionsProvider, useTaskActions } from "./useTaskActions";
import { useRetentionInteraction } from "./useRetentionInteraction";
import { api } from "./api";
import { makeTask } from "../test/fixtures";

vi.mock("./api", () => ({ api: { completeTask: vi.fn(), updateTask: vi.fn() } }));
const mockedApi = vi.mocked(api, true);
function wrapper({ children }: { children: ReactNode }) {
  return <LocaleProvider initialLocale="de"><RefreshProvider><TaskActionsProvider>{children}</TaskActionsProvider></RefreshProvider></LocaleProvider>;
}

describe("task placement interaction ownership", () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

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
});
