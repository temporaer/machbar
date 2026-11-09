import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { RefreshProvider, useRefresh } from "./refresh";
import { api } from "./api";
import { useRefinementActions, type RefinementListItem } from "./useRefinementActions";
import { makeTask } from "../test/fixtures";
import { TaskActionsProvider } from "./useTaskActions";

vi.mock("./api", () => ({ api: { updateTask: vi.fn() } }));
const mockedApi = vi.mocked(api, true);
function makeItem(overrides: Partial<RefinementListItem> = {}): RefinementListItem {
  return { ...makeTask(), projectTitle: null, inheritedOwnerId: null, ...overrides };
}
function wrapper({ children }: { children: ReactNode }) {
  return <RefreshProvider><TaskActionsProvider>{children}</TaskActionsProvider></RefreshProvider>;
}
describe("server-confirmed refinement commands", () => {
  beforeEach(() => vi.clearAllMocks());
  it("cycles size with the current revision and invalidates immediately", async () => {
    const task = makeItem({ id: 10, size: "M" });
    mockedApi.updateTask.mockResolvedValue({ ...makeTask(), size: "L" });
    const { result } = renderHook(() => ({ actions: useRefinementActions(), refresh: useRefresh() }), { wrapper });
    const before = result.current.refresh.version;
    await act(async () => { await result.current.actions.cycleSize(task); });
    expect(mockedApi.updateTask).toHaveBeenCalledWith(10, { size: "L", expectedRevision: task.revision });
    expect(result.current.refresh.version).toBe(before + 1);
    expect(task.size).toBe("M");
  });
  it("records and clears a failed size command without invalidation", async () => {
    const task = makeItem({ id: 11 });
    mockedApi.updateTask.mockRejectedValue(new Error("Network failed"));
    const { result } = renderHook(() => ({ actions: useRefinementActions(), refresh: useRefresh() }), { wrapper });
    const before = result.current.refresh.version;
    await act(async () => { await result.current.actions.setSize(task, "L"); });
    expect(result.current.actions.errors[11]).toBe("Network failed");
    expect(result.current.refresh.version).toBe(before);
    act(() => result.current.actions.clearError(11));
    expect(result.current.actions.errors[11]).toBeUndefined();
  });
  it("clears size through the canonical task mutation", async () => {
    const task = makeItem({ id: 12, size: "XL" });
    mockedApi.updateTask.mockResolvedValue(makeTask({ size: null }));
    const { result } = renderHook(() => useRefinementActions(), { wrapper });
    await act(async () => { await result.current.clearSize(task); });
    expect(mockedApi.updateTask).toHaveBeenCalledWith(12, { size: null, expectedRevision: task.revision });
  });
  it.each([
    { owner: 7, mode: "explicit" as const },
    { owner: null, mode: "inherit" as const },
    { owner: null, mode: "none" as const },
  ])("preserves revision-safe $mode ownership without client-derived owner projection", async ({ owner, mode }) => {
    const task = makeItem({ id: 13, revision: 4, inheritedOwnerId: 5 });
    mockedApi.updateTask.mockResolvedValue(makeTask());
    const { result } = renderHook(() => useRefinementActions(), { wrapper });
    await act(async () => { await result.current.assignOwner(task, owner, mode); });
    expect(mockedApi.updateTask).toHaveBeenCalledWith(13, {
      ownerMemberId: owner, ownerInheritanceMode: mode, expectedRevision: 4,
    });
  });
});
