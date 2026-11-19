import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "./locale";
import { RefreshProvider } from "./refresh";
import { TaskActionsProvider, useTaskActions } from "./useTaskActions";
import { api } from "./api";
import { makeTask } from "../test/fixtures";
import { useAsync } from "./useAsync";

vi.mock("./api", () => ({ api: { updateTask: vi.fn(), completeTask: vi.fn(), moveTask: vi.fn() } }));
const mockedApi = vi.mocked(api, true);
function wrapper({ children }: { children: ReactNode }) {
  return <LocaleProvider initialLocale="de"><RefreshProvider><TaskActionsProvider>{children}</TaskActionsProvider></RefreshProvider></LocaleProvider>;
}

describe("server-confirmed task sequence contract", () => {
  afterEach(() => vi.clearAllMocks());

  it.each(["save-first", "refresh-first"])("never overlays an independent server read: %s", async order => {
    const original = makeTask({ id: 1, title: "Original" });
    const fresh = { ...original, revision: 3, title: "Changed elsewhere", blocked: true };
    let confirm!: (value: ReturnType<typeof makeTask>) => void;
    mockedApi.updateTask.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    const { result, rerender } = renderHook(({ task }) => ({ actions: useTaskActions(), task }), {
      wrapper, initialProps: { task: original },
    });
    let saving!: Promise<unknown>;
    act(() => { saving = result.current.actions.update(original, { title: "Authored edit" }); });
    expect(result.current.task).toBe(original);
    if (order === "refresh-first") rerender({ task: fresh });
    await act(async () => { confirm({ ...original, revision: 2, title: "Authored edit" }); await saving; });
    if (order === "save-first") rerender({ task: fresh });
    expect(result.current.task).toBe(fresh);
    expect(result.current.actions.isPending(1)).toBe(false);
  });

  it("shares the one-command-per-task gate across consumers", async () => {
    const task = makeTask();
    let confirm!: (value: ReturnType<typeof makeTask>) => void;
    mockedApi.updateTask.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    const { result } = renderHook(() => ({ editor: useTaskActions(), row: useTaskActions() }), { wrapper });
    let saving!: Promise<unknown>;
    act(() => { saving = result.current.editor.update(task, { title: "Edited" }); });
    await act(async () => { await result.current.row.complete(task); });
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(result.current.row.errors[task.id]).toBeTruthy();
    await act(async () => { confirm(task); await saving; });
  });

  it("does not send an old completion into a reopened feedback surface, even with reused callbacks", async () => {
    const task = makeTask();
    let confirm!: (value: typeof task) => void;
    mockedApi.completeTask.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
    const { result } = renderHook(() => useTaskActions(), { wrapper });
    const observer = { pendingMessage: "Completing", onCommitted: vi.fn() };
    const retire = result.current.registerCompletionFeedback(observer);
    let command!: Promise<unknown>;
    act(() => { command = result.current.complete(task); });
    retire();
    result.current.registerCompletionFeedback(observer);
    retire(); // Cleanup from the former registration must not retire its replacement.
    await act(async () => { confirm(task); await command; });
    expect(observer.onCommitted).not.toHaveBeenCalled();
    mockedApi.completeTask.mockResolvedValue(task);
    await act(async () => { await result.current.complete(task); });
    expect(observer.onCommitted).toHaveBeenCalledExactlyOnceWith(task);
  });

  it("invalidates only the captured identity after its action provider is replaced", async () => {
    const task = makeTask();
    let confirm!: (value: typeof task) => void;
    mockedApi.completeTask.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
    let identity = 1;
    const fetcher = vi.fn(async () => `identity ${identity}`);
    const observer = { pendingMessage: "Completing", onCommitted: vi.fn() };
    function identityWrapper({ children }: { children: ReactNode }) {
      return <LocaleProvider initialLocale="de"><RefreshProvider key={identity}><TaskActionsProvider>{children}</TaskActionsProvider></RefreshProvider></LocaleProvider>;
    }
    const { result, rerender } = renderHook(() => ({ actions: useTaskActions(), read: useAsync(fetcher) }), { wrapper: identityWrapper });
    await waitFor(() => expect(result.current.read.data).toBe("identity 1"));
    result.current.actions.registerCompletionFeedback(observer);
    let command!: Promise<unknown>;
    act(() => { command = result.current.actions.complete(task); });
    identity = 2;
    rerender();
    await waitFor(() => expect(result.current.read.data).toBe("identity 2"));
    const readsBeforeCommit = fetcher.mock.calls.length;
    await act(async () => { confirm(task); await command; });
    expect(fetcher).toHaveBeenCalledTimes(readsBeforeCommit);
    expect(result.current.actions.isPending(task.id)).toBe(false);
    expect(observer.onCommitted).not.toHaveBeenCalled();
  });

  it("requires an explicit descendant decision before issuing a terminal command", async () => {
    const task = makeTask({ children: [makeTask({ id: 2 })] });
    mockedApi.completeTask.mockResolvedValue({ ...task, revision: 2, status: "done" });
    const { result } = renderHook(() => useTaskActions(), { wrapper });
    act(() => result.current.requestToggle(task));
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(result.current.pendingTask).toBe(task);
    await act(async () => result.current.resolvePolicy("cancel_children"));
    expect(mockedApi.completeTask).toHaveBeenCalledWith(task.id, "cancel_children", undefined, task.revision);
    expect(result.current.pendingTask).toBeNull();
  });

  it("shares an outline move's gate with metadata editors until the write settles", async () => {
    const task = makeTask({ revision: 7 });
    const destination = { parentTaskId: null, projectId: 2, expectedRevision: task.revision };
    let confirm!: (value: typeof task) => void;
    mockedApi.moveTask.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
    const { result } = renderHook(() => ({ outline: useTaskActions(), editor: useTaskActions() }), { wrapper });
    let moving!: Promise<unknown>;
    act(() => { moving = result.current.outline.move(task, destination); });
    await act(async () => {
      await expect(result.current.editor.update(task, { title: "Edited" }, true)).rejects.toThrow();
    });
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(result.current.editor.isPending(task.id)).toBe(true);
    expect(mockedApi.moveTask).toHaveBeenCalledExactlyOnceWith(task.id, destination);
    await act(async () => { confirm(task); await moving; });
    expect(result.current.editor.isPending(task.id)).toBe(false);
  });
});
