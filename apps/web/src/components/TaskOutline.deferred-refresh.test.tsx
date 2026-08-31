import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { Task } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { useRefresh } from "../lib/refresh";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { RETENTION_MS, useTaskActions } from "../lib/useTaskActions";
import { makeMember, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    reorderTask: vi.fn(),
    indentTask: vi.fn(),
    outdentTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

/** Flushes the microtask queue (mutation `await`s) without depending on real timers. */
async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/** Records every distinct `version` the shared `RefreshProvider` produces, in order. */
function VersionLog({ log }: { log: number[] }) {
  const { version } = useRefresh();
  useEffect(() => {
    log.push(version);
  }, [log, version]);
  return null;
}

/**
 * Exercises `useTaskActions` directly, bypassing `TaskRow`'s UI-level
 * disabling of a retained row's own controls (by design, a retained row's
 * checkbox is disabled — see `TaskRow.retention.test.tsx` — so a real second
 * click can't reach the hook mid-window). This is a true unit test of the
 * hook's own supersede/idempotency guarantees, independent of what the
 * chip/checkbox UI currently allows.
 */
function HookHarness({ task }: { task: Task }) {
  const actions = useTaskActions();
  return (
    <div>
      <button type="button" onClick={() => void actions.complete(task)}>
        do-complete
      </button>
      <button type="button" onClick={() => void actions.reopen(task)}>
        do-reopen
      </button>
    </div>
  );
}

/**
 * Stands in for a real compiled-view page (Heute/Eingang/Suche/…): it only
 * re-derives what it shows from the "server" when the global refresh bumps,
 * and — just like `TodayPage`'s `.filter((s) => agenda[s.key].length > 0)` —
 * it stops rendering its `TaskOutline` (and the section around it) the
 * moment that server-derived list is empty. This lets a component test
 * reproduce the "compiled section unmounts and destroys per-TaskOutline
 * retained state" failure mode without touching any page component.
 */
function CompiledSectionHarness({ beforeTasks, afterTasks }: { beforeTasks: Task[]; afterTasks: Task[] }) {
  const { version } = useRefresh();
  const baseline = useRef(version);
  const [serverTasks, setServerTasks] = useState(beforeTasks);
  useEffect(() => {
    if (version === baseline.current) return;
    setServerTasks(afterTasks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  if (serverTasks.length === 0) return <div data-testid="section-empty" />;
  return (
    <div data-testid="section">
      <TaskOutline tasks={serverTasks} emptyMessage="Nichts da" />
    </div>
  );
}

describe("useTaskActions – deferred global refresh vs. compiled-section unmount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not bump (and so does not let the compiled section unmount) before the full retention window elapses, then bumps exactly once at expiry", async () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 500, title: "Rasen mähen", status: "actionable" });
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done" });
    const versionLog: number[] = [];

    renderWithProviders(
      <>
        <VersionLog log={versionLog} />
        <CompiledSectionHarness beforeTasks={[task]} afterTasks={[]} />
      </>,
    );
    expect(screen.getByText("Rasen mähen")).toBeInTheDocument();
    expect(versionLog).toEqual([0]);

    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    await act(async () => {
      await flushMicrotasks();
    });

    // Optimistic cross-out happens immediately, but the section must not
    // have been asked to re-derive its data yet — no bump yet.
    expect(screen.getByText("Rasen mähen").className).toContain("done");
    expect(screen.getByTestId("section")).toBeInTheDocument();
    expect(versionLog).toEqual([0]);

    // Just shy of the retention window: still crossed out, section still
    // mounted, still no bump — this is exactly the "split second" window the
    // bug report described collapsing to.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS - 250);
    });
    expect(screen.getByText("Rasen mähen")).toBeInTheDocument();
    expect(screen.getByText("Rasen mähen").className).toContain("done");
    expect(screen.getByTestId("section")).toBeInTheDocument();
    expect(versionLog).toEqual([0]);

    // Past the window: exactly one bump fires, the harness re-derives its
    // "server" data (now empty), and the whole section — TaskOutline
    // included — is finally allowed to unmount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(versionLog).toEqual([0, 1]);
    expect(screen.queryByTestId("section")).not.toBeInTheDocument();
    expect(screen.getByTestId("section-empty")).toBeInTheDocument();
    expect(screen.queryByText("Rasen mähen")).not.toBeInTheDocument();
  });

  it("never bumps, and rolls back immediately with an inline error, when the mutation fails — no delayed refresh is left behind", async () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 501, title: "Fehlerhafte Aufgabe", status: "actionable" });
    mockedApi.completeTask.mockRejectedValue(new Error("Netzwerkfehler"));
    const versionLog: number[] = [];

    renderWithProviders(
      <>
        <VersionLog log={versionLog} />
        <CompiledSectionHarness beforeTasks={[task]} afterTasks={[]} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(screen.getByText("Netzwerkfehler")).toBeInTheDocument();
    expect(screen.getByText("Fehlerhafte Aufgabe").className).not.toContain("done");
    expect(versionLog).toEqual([0]);

    // Wait well past what would have been the retention window: a failure
    // must not leave a straggling timer that bumps later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS + 2000);
    });
    expect(versionLog).toEqual([0]);
    expect(screen.getByTestId("section")).toBeInTheDocument();
    expect(screen.getByText("Fehlerhafte Aufgabe")).toBeInTheDocument();
  });

  it("keeps one per-task retention deadline across confirmed complete and reopen responses", async () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 502, title: "Wird umentschieden", status: "actionable" });
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done" });
    mockedApi.reopenTask.mockResolvedValue({ ...task, status: "actionable" });
    const versionLog: number[] = [];

    renderWithProviders(
      <>
        <VersionLog log={versionLog} />
        <HookHarness task={task} />
      </>,
    );

    fireEvent.click(screen.getByText("do-complete"));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(versionLog).toEqual([0]);

    // Reopen well before the task's retention window elapses. The shared
    // runtime updates the same retained entry instead of adding another timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS - 1000);
    });
    fireEvent.click(screen.getByText("do-reopen"));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(versionLog).toEqual([0]);

    // The original per-task deadline emits one refresh for the latest
    // confirmed response.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(versionLog).toEqual([0, 1]);

    // There is no second timer for the reopen response.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS);
    });
    expect(versionLog).toEqual([0, 1]);
  });

  it("clears its retention timer on unmount and never bumps afterwards", async () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 503, title: "Verschwindet beim Unmount", status: "actionable" });
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done" });
    const versionLog: number[] = [];

    const { unmount } = renderWithProviders(
      <>
        <VersionLog log={versionLog} />
        <CompiledSectionHarness beforeTasks={[task]} afterTasks={[]} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(versionLog).toEqual([0]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS + 1000);
    });
    // No React "state update on an unmounted component" warning, and the
    // pending bump never fired post-unmount.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
