import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { RefreshProvider, useRefresh } from "../lib/refresh";
import { api } from "./api";
import { REFINEMENT_RETENTION_MS, nextSizeInCycle, useRefinementActions } from "./useRefinementActions";
import type { RefinementListItem } from "./useRefinementActions";

vi.mock("./api", () => ({
  api: {
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function makeItem(overrides: Partial<RefinementListItem> = {}): RefinementListItem {
  return {
    id: 1,
    title: "Beispielaufgabe",
    status: "actionable",
    size: null,
    projectId: null,
    projectTitle: null,
    effectiveOwnerId: null,
    effectiveOwnerSource: "none",
    position: 0,
    updatedAt: "2026-01-01T09:00:00.000Z",
    blocked: false,
    effectiveTags: [],
    waitingFor: null,
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <RefreshProvider>{children}</RefreshProvider>;
}

describe("nextSizeInCycle", () => {
  it("cycles null -> S -> M -> L -> XL -> null, so XL wraps back to unestimated rather than sticking", () => {
    expect(nextSizeInCycle(null)).toBe("S");
    expect(nextSizeInCycle("S")).toBe("M");
    expect(nextSizeInCycle("M")).toBe("L");
    expect(nextSizeInCycle("L")).toBe("XL");
    expect(nextSizeInCycle("XL")).toBe(null);
  });
});

describe("useRefinementActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a ~4s retention window, matching the 'about 4s' requirement", () => {
    expect(REFINEMENT_RETENTION_MS).toBeGreaterThanOrEqual(3000);
    expect(REFINEMENT_RETENTION_MS).toBeLessThanOrEqual(5000);
  });

  it("optimistically retains a task's new size immediately, then releases it (and bumps refresh) once retention elapses", async () => {
    vi.useFakeTimers();
    const task = makeItem({ id: 10, size: "M" });
    mockedApi.updateTask.mockResolvedValue({ ...task, size: "L" } as never);

    const { result } = renderHook(
      () => ({ actions: useRefinementActions(), refresh: useRefresh() }),
      { wrapper },
    );

    await act(async () => {
      await result.current.actions.cycleSize(task);
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(10, { size: "L" });
    expect(result.current.actions.retained.get(10)?.size).toBe("L");
    const versionAfterMutation = result.current.refresh.version;

    // Not yet expired: still retained, and no refresh bump yet (the
    // compiled list must not reshuffle mid-window).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFINEMENT_RETENTION_MS - 500);
    });
    expect(result.current.actions.retained.has(10)).toBe(true);
    expect(result.current.refresh.version).toBe(versionAfterMutation);

    // Past the window: released, and exactly one deferred bump fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.actions.retained.has(10)).toBe(false);
    expect(result.current.refresh.version).toBe(versionAfterMutation + 1);
  });

  it("rolls back and records an inline error when the size mutation fails, without retaining a bad optimistic state", async () => {
    const task = makeItem({ id: 11, size: "S" });
    mockedApi.updateTask.mockRejectedValue(new Error("Netzwerkfehler"));

    const { result } = renderHook(() => useRefinementActions(), { wrapper });

    await act(async () => {
      await result.current.setSize(task, "L");
    });

    expect(result.current.retained.has(11)).toBe(false);
    expect(result.current.errors[11]).toBe("Netzwerkfehler");

    act(() => result.current.clearError(11));
    expect(result.current.errors[11]).toBeUndefined();
  });

  it("clearSize sets size to null", async () => {
    const task = makeItem({ id: 12, size: "XL" });
    mockedApi.updateTask.mockResolvedValue({ ...task, size: null } as never);

    const { result } = renderHook(() => useRefinementActions(), { wrapper });
    await act(async () => {
      await result.current.clearSize(task);
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(12, { size: null });
    expect(result.current.retained.get(12)?.size).toBe(null);
  });
});
