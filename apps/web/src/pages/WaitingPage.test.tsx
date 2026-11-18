import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Task } from "@machbar/shared";
import { WaitingPage } from "./WaitingPage";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeTask } from "../test/fixtures";
import { useTaskActions } from "../lib/useTaskActions";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getWaiting: vi.fn(),
    completeTask: vi.fn(),
  },
}));

function TaskAccessProbe({ taskId, denied = false }: { taskId: number; denied?: boolean }) {
  const { error, reload } = useAsync(
    async () => {
      if (denied) throw Object.assign(new Error("Task access denied"), { name: "ApiError", status: 403 });
      return true;
    },
    [taskId],
    { type: "task", taskId },
  );
  return <>
    <button onClick={reload}>Refresh task access</button>
    {error ? <p role="alert">{error}</p> : null}
  </>;
}

function UnrelatedAccessProbe({ denied = false }: { denied?: boolean }) {
  const { error, reload } = useAsync(async () => {
    if (denied) throw Object.assign(new Error("Unrelated access denied"), { name: "ApiError", status: 403 });
    return true;
  });
  return <>
    <button onClick={reload}>Refresh unrelated data</button>
    {error ? <p role="alert">{error}</p> : null}
  </>;
}

function CompletionHarness({
  task, visible = true, taskAccessDenied = false, unrelatedAccessDenied = false,
}: {
  task: Task;
  visible?: boolean;
  taskAccessDenied?: boolean;
  unrelatedAccessDenied?: boolean;
}) {
  const actions = useTaskActions();
  const { bump } = useRefresh();
  return <>
    <button onClick={() => { void actions.complete(task); }}>Complete fixture</button>
    <button onClick={() => { void bump(); }}>Refresh fixture</button>
    <TaskAccessProbe taskId={task.id} denied={taskAccessDenied} />
    <UnrelatedAccessProbe denied={unrelatedAccessDenied} />
    {visible ? <WaitingPage /> : null}
  </>;
}

describe("WaitingPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getMembers).mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
    ]);
  });

  it("confirms a recurring occurrence without changing the fresh continuing task", async () => {
    const task = makeTask({ title: "Recurring work", repeatAfterDays: 7, scheduledDate: "2026-01-01" });
    const fresh = { ...task, revision: task.revision + 1, scheduledDate: "2026-01-08", notes: "Fresh authoritative notes" };
    vi.mocked(api.getWaiting).mockResolvedValue([{ task, reasons: [{ type: "context", contexts: [] }] }]);
    vi.mocked(api.completeTask).mockResolvedValue(fresh);
    renderWithProviders(<CompletionHarness task={task} />);
    await screen.findByText(task.title, { exact: true });
    vi.mocked(api.getWaiting).mockResolvedValue([{ task: fresh, reasons: [{ type: "context", contexts: [] }] }]);
    fireEvent.click(screen.getByText("Complete fixture"));
    expect(await screen.findByText(`Durchgang von „${task.title}“ erledigt.`)).toBeInTheDocument();
    expect(await screen.findByText("Fresh authoritative notes")).toBeInTheDocument();
    expect(screen.getByText(task.title, { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(`„${task.title}“ erledigt.`)).not.toBeInTheDocument();
  });

  it.each(["view", "access"] as const)("removes an already-visible notice on %s retirement", async retirement => {
    const task = makeTask({ title: "Private confirmation" });
    vi.mocked(api.getWaiting).mockResolvedValue([{ task, reasons: [{ type: "external", waitingFor: "Supplier", revisitAt: null }] }]);
    vi.mocked(api.completeTask).mockResolvedValue({ ...task, status: "done" });
    const { rerender } = renderWithProviders(<CompletionHarness task={task} />);
    await screen.findByText(task.title, { exact: true });
    vi.mocked(api.getWaiting).mockResolvedValue([]);
    fireEvent.click(screen.getByText("Complete fixture"));
    const message = `„${task.title}“ erledigt.`;
    await screen.findByText(message);
    if (retirement === "view") {
      rerender(<CompletionHarness task={task} visible={false} />);
    } else {
      vi.mocked(api.getWaiting).mockRejectedValue(Object.assign(new Error("Access revoked"), { name: "ApiError", status: 403 }));
      fireEvent.click(screen.getByText("Refresh fixture"));
      await screen.findByRole("alert");
    }
    await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument());
  });

  it("does not retire Waiting feedback for an unrelated access denial", async () => {
    const task = makeTask({ title: "Still allowed" });
    vi.mocked(api.getWaiting).mockResolvedValue([{ task, reasons: [{ type: "context", contexts: [] }] }]);
    vi.mocked(api.completeTask).mockResolvedValue({ ...task, status: "done" });
    const { rerender } = renderWithProviders(<CompletionHarness task={task} />);
    await screen.findByText(task.title, { exact: true });
    rerender(<CompletionHarness task={task} unrelatedAccessDenied />);
    fireEvent.click(screen.getByText("Refresh unrelated data"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Complete fixture"));
    expect(await screen.findByText(`„${task.title}“ erledigt.`)).toBeInTheDocument();
  });

  it("retires matching task feedback and suppresses a stale completion callback after access denial", async () => {
    const task = makeTask({ title: "Private task confirmation" });
    let confirmSecond!: (value: Task) => void;
    vi.mocked(api.getWaiting).mockResolvedValue([{ task, reasons: [{ type: "context", contexts: [] }] }]);
    vi.mocked(api.completeTask)
      .mockResolvedValueOnce({ ...task, status: "done" })
      .mockImplementationOnce(() => new Promise(resolve => { confirmSecond = resolve; }));
    const { rerender } = renderWithProviders(<CompletionHarness task={task} />);
    await screen.findByText(task.title, { exact: true });
    fireEvent.click(screen.getByText("Complete fixture"));
    const message = `„${task.title}“ erledigt.`;
    await screen.findByText(message);
    fireEvent.click(screen.getByText("Complete fixture"));
    await waitFor(() => expect(api.completeTask).toHaveBeenCalledTimes(2));
    rerender(<CompletionHarness task={task} taskAccessDenied />);
    fireEvent.click(screen.getByText("Refresh task access"));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument());
    await act(async () => {
      confirmSecond({ ...task, status: "done" });
      await Promise.resolve();
    });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it("renders typed waiting entries", async () => {
    vi.mocked(api.getWaiting).mockResolvedValue([
      {
        task: makeTask({
          title: "Freigabe abwarten",
          externalWait: { waitingFor: "Freigabe", revisitDate: null },
        }),
        reasons: [
          { type: "external", waitingFor: "Freigabe", revisitDate: null },
        ],
      },
    ]);
    renderWithProviders(<WaitingPage />);
    expect(await screen.findByText("Freigabe abwarten")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Extern" })).toBeInTheDocument();
  });
});
