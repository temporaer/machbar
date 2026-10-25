import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { Task } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { useRefresh } from "../lib/refresh";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { RETENTION_MS, useTaskActions } from "../lib/useTaskActions";
import { useRetainedPlacement } from "../lib/useRetainedPlacement";
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

/** Exercises repeated confirmed mutations through the shared controller. */
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

/** Keeps placement at the page level even when fresh server data is empty. */
function CompiledSectionHarness({ beforeTasks, afterTasks }: { beforeTasks: Task[]; afterTasks: Task[] }) {
  const { version } = useRefresh();
  const baseline = useRef(version);
  const [serverTasks, setServerTasks] = useState(beforeTasks);
  useEffect(() => {
    if (version === baseline.current) return;
    setServerTasks(afterTasks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const actions = useTaskActions();
  const { rows } = useRetainedPlacement({ rows: serverTasks }, actions.holdingIds, (task) => actions.retained.get(task.id) ?? task);
  if (rows.length === 0) return <div data-testid="section-empty" />;
  return (
    <div data-testid="section">
      <TaskOutline tasks={rows} emptyMessage="Nichts da" />
    </div>
  );
}

describe("useTaskActions – immediate refresh with retained placement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes immediately while retaining the last compiled row until expiry", async () => {
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

    expect(screen.getByText("Rasen mähen").className).toContain("done");
    expect(screen.getByTestId("section")).toBeInTheDocument();
    expect(versionLog).toEqual([0, 1]);

    await act(async () => { await vi.advanceTimersByTimeAsync(RETENTION_MS - 250); });
    expect(screen.getByText("Rasen mähen")).toBeInTheDocument();
    expect(versionLog).toEqual([0, 1]);

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(versionLog).toEqual([0, 1]);
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
    expect(versionLog).toEqual([0, 1]);

    // Reopen well before the task's retention window elapses. The shared
    // runtime updates the same retained entry instead of adding another timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS - 1000);
    });
    fireEvent.click(screen.getByText("do-reopen"));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(versionLog).toEqual([0, 1, 2]);

    // The previous deadline must not emit another refresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(versionLog).toEqual([0, 1, 2]);

    // Expiring placement does not emit another refresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS);
    });
    expect(versionLog).toEqual([0, 1, 2]);
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
    expect(versionLog).toEqual([0, 1]);

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
