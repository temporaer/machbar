import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { renderWithProviders } from "../test/testUtils";
import {
  TaskListTransitionDepartures,
  TaskOutline,
  TaskOutlineInTransitionView,
} from "./TaskOutline";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { makeTask } from "../test/fixtures";
import { useInteractionScope } from "../lib/interactionScope";
import {
  TASK_TRANSITION_CONFIRMATION_MS,
  TaskListTransitionFeedbackProvider,
} from "../lib/taskListTransitionFeedback";

vi.mock("../lib/api", () => ({ api: {
  getMembers: vi.fn().mockResolvedValue([]), getTags: vi.fn().mockResolvedValue([]),
  searchTasks: vi.fn(), completeTask: vi.fn(), cancelTask: vi.fn(),
} }));
const mockedApi = vi.mocked(api, true);
function OpenLifecycle({ taskId }: { taskId: number }) {
  const { setOpenLifecycle } = useInteractionScope();
  useEffect(() => { setOpenLifecycle(taskId); }, [setOpenLifecycle, taskId]);
  return null;
}
function CompiledSection({ openLifecycleTaskId }: { openLifecycleTaskId?: number } = {}) {
  const { data, reload } = useAsync(() => api.searchTasks({}), []);
  return <>
    <button type="button" onClick={reload}>Refresh server view</button>
    {openLifecycleTaskId !== undefined ? <OpenLifecycle taskId={openLifecycleTaskId} /> : null}
    <TaskOutline tasks={data ?? []} emptyMessage="Empty server view" />
  </>;
}
function ExternalDepartureSection() {
  const { data } = useAsync(() => api.searchTasks({}), []);
  return (
    <TaskListTransitionFeedbackProvider identityKey="test">
      <TaskOutlineInTransitionView tasks={data ?? []} emptyMessage="Empty server view" />
      <TaskListTransitionDepartures />
    </TaskListTransitionFeedbackProvider>
  );
}
function RelocatedTransitionSection({ task }: { task: ReturnType<typeof makeTask> }) {
  const [inSource, setInSource] = useState(true);
  const [inDestination, setInDestination] = useState(false);
  return (
    <TaskListTransitionFeedbackProvider identityKey="test">
      <button type="button" onClick={() => {
        setInSource(false);
        setInDestination(true);
      }}>
        Move to completed outline
      </button>
      {inSource ? <TaskOutlineInTransitionView tasks={[task]} emptyMessage="Empty source" /> : null}
      {inDestination ? (
        <TaskOutlineInTransitionView tasks={[{ ...task, status: "done", revision: task.revision + 1 }]} emptyMessage="Empty destination" />
      ) : null}
      <TaskListTransitionDepartures />
    </TaskListTransitionFeedbackProvider>
  );
}
function SiblingTransitionSection({ task }: { task: ReturnType<typeof makeTask> }) {
  const [sourceTasks, setSourceTasks] = useState([task, makeTask({ id: task.id + 1, title: "Remaining source row" })]);
  const [destinationTasks, setDestinationTasks] = useState<typeof sourceTasks>([]);
  return (
    <TaskListTransitionFeedbackProvider identityKey="test">
      <button type="button" onClick={() => {
        setSourceTasks(sourceTasks.slice(1));
        setDestinationTasks([{ ...task, status: "done", revision: task.revision + 1 }]);
      }}>
        Transfer task
      </button>
      <TaskOutlineInTransitionView tasks={sourceTasks} emptyMessage="Empty source" />
      <TaskOutlineInTransitionView tasks={destinationTasks} emptyMessage="Empty destination" />
      <TaskListTransitionDepartures />
    </TaskListTransitionFeedbackProvider>
  );
}

describe("server-confirmed compiled task rows", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useRealTimers(); window.localStorage.clear(); });
  it("announces completion while the server command is still pending", async () => {
    const task = makeTask({ title: "Slow server row" });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.completeTask.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<CompiledSection />);
    const title = await screen.findByText(task.title);
    fireEvent.click(within(title.closest("li")!).getByRole("button", { name: "Erledigt" }));
    expect(title).toHaveClass("done");
    const row = title.closest("li")!;
    expect(row).not.toHaveAttribute("aria-busy", "true");
    expect(row.querySelector(".task-row-content")).toHaveAttribute("aria-busy", "true");
    expect(within(row).getByRole("status")).toHaveTextContent("Wird erledigt");
    fireEvent.click(within(title.closest("li")!).getByRole("button", { name: /Wird erledigt/ }));
    expect(mockedApi.completeTask).toHaveBeenCalledTimes(1);
  });
  it("keeps fast successful completion visible briefly after membership refresh removes it", async () => {
    const task = makeTask({ title: "Server row" });
    mockedApi.searchTasks.mockResolvedValueOnce([task]).mockResolvedValue([]);
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done", revision: 2 });
    renderWithProviders(<CompiledSection />);
    await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    await waitFor(() => expect(screen.getByText(task.title).closest("li")).toHaveAttribute("aria-disabled", "true"));
    const title = screen.getByText(task.title);
    expect(title).toHaveClass("done");
    expect(within(title.closest("li")!).getByRole("status")).toHaveTextContent("Erledigt");
    expect(title.closest("li")!.querySelectorAll("button")).toHaveLength(0);
    await new Promise(resolve => setTimeout(resolve, 2_500));
    expect(screen.getByText(task.title)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(task.title)).not.toBeInTheDocument());
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    expect(screen.getByText("Empty server view")).toBeInTheDocument();
  });
  it("keeps pending feedback through a refresh delayed beyond the confirmation interval", async () => {
    const task = makeTask({ title: "Slow refresh row" });
    let releaseRead!: (tasks: typeof task[]) => void;
    const delayedRead = new Promise<typeof task[]>(resolve => { releaseRead = resolve; });
    let reads = 0;
    mockedApi.searchTasks.mockImplementation(() => {
      reads += 1;
      return reads === 1 ? Promise.resolve([task]) : delayedRead;
    });
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done", revision: 2 });
    renderWithProviders(<CompiledSection />);
    await screen.findByText(task.title);
    const row = screen.getByText(task.title).closest("li")!;
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));

    await waitFor(() => expect(reads).toBeGreaterThan(1));
    await new Promise(resolve => setTimeout(resolve, TASK_TRANSITION_CONFIRMATION_MS + 200));
    expect(screen.getByText(task.title)).toBeInTheDocument();
    expect(within(row).getByRole("status")).toHaveTextContent("Wird erledigt");

    await act(async () => { releaseRead([]); });
    const departure = screen.getByText(task.title).closest("li")!;
    await waitFor(() => expect(within(departure).getByRole("status")).toHaveTextContent("Erledigt"));
    expect(departure).toHaveAttribute("aria-disabled", "true");
  });
  it("does not render a detached task in both local and external departure lists", async () => {
    const task = makeTask({ title: "Cancelled Today row" });
    mockedApi.searchTasks.mockResolvedValueOnce([task]).mockResolvedValue([]);
    mockedApi.cancelTask.mockResolvedValue({ ...task, status: "cancelled", revision: 2 });
    renderWithProviders(
      <>
        <OpenLifecycle taskId={task.id} />
        <ExternalDepartureSection />
      </>,
    );
    await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Verworfen" }));

    await waitFor(() =>
      expect(screen.getByText(task.title).closest("li")).toHaveAttribute("aria-disabled", "true"),
    );
    const row = screen.getByText(task.title).closest("li")!;
    expect(within(row).getByRole("status")).toHaveTextContent("Verworfen");
  });
  it("moves confirmation to a visible authoritative row when its source outline unmounts", async () => {
    const task = makeTask({ title: "Completed in another section" });
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done", revision: task.revision + 1 });
    renderWithProviders(<RelocatedTransitionSection task={task} />);
    await screen.findByText(task.title);
    const sourceRow = screen.getByText(task.title).closest("li")!;
    fireEvent.click(within(sourceRow).getByRole("button", { name: "Erledigt" }));
    await waitFor(() => expect(within(sourceRow).getByRole("status")).toHaveTextContent("Erledigt"));
    fireEvent.click(screen.getByRole("button", { name: "Move to completed outline" }));

    await waitFor(() => expect(screen.getAllByText(task.title)).toHaveLength(1));
    const row = screen.getByText(task.title).closest("li")!;
    expect(row).not.toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByRole("status")).toHaveTextContent("Erledigt");
    expect(screen.getAllByRole("status").filter(status => status.textContent === "Erledigt")).toHaveLength(1);
  });
  it("moves confirmation to a sibling outline without duplicating a departure", async () => {
    const task = makeTask({ title: "Transferred while source remains" });
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done", revision: task.revision + 1 });
    renderWithProviders(<SiblingTransitionSection task={task} />);
    await screen.findByText(task.title);
    fireEvent.click(within(screen.getByText(task.title).closest("li")!)
      .getByRole("button", { name: "Erledigt" }));

    await waitFor(() => expect(within(screen.getByText(task.title).closest("li")!)
      .getByRole("status")).toHaveTextContent("Erledigt"));
    fireEvent.click(screen.getByRole("button", { name: "Transfer task" }));

    await waitFor(() => expect(screen.getAllByText(task.title)).toHaveLength(1));
    const row = screen.getByText(task.title).closest("li")!;
    expect(row).not.toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByRole("status")).toHaveTextContent("Erledigt");
    expect(screen.getAllByRole("status").filter(status => status.textContent === "Erledigt")).toHaveLength(1);
  });
  it("keeps concurrent departures in their original root order", async () => {
    const first = makeTask({ title: "First removed row", position: 0 });
    const second = makeTask({ title: "Second removed row", position: 1 });
    const remaining = makeTask({ title: "Remaining row", position: 2 });
    let releaseRead!: (tasks: typeof first[]) => void;
    const delayedRead = new Promise<typeof first[]>(resolve => { releaseRead = resolve; });
    let reads = 0;
    mockedApi.searchTasks.mockImplementation(() => {
      reads += 1;
      return reads === 1 ? Promise.resolve([first, second, remaining]) : delayedRead;
    });
    mockedApi.completeTask.mockImplementation(async id => ({
      ...(id === first.id ? first : second),
      status: "done",
      revision: 2,
    }));
    const { container } = renderWithProviders(<CompiledSection />);
    await screen.findByText(first.title);
    fireEvent.click(within(screen.getByText(first.title).closest("li")!)
      .getByRole("button", { name: "Erledigt" }));
    fireEvent.click(within(screen.getByText(second.title).closest("li")!)
      .getByRole("button", { name: "Erledigt" }));

    await waitFor(() => expect(reads).toBeGreaterThan(1));
    await act(async () => { releaseRead([remaining]); });
    await waitFor(() => expect(container.querySelectorAll("li.task-row[aria-disabled='true']"))
      .toHaveLength(2));
    expect([...container.querySelectorAll(".task-row-title")].map(title => title.textContent))
      .toEqual([first.title, second.title, remaining.title]);
  });
  it("keeps sequential departures in their original root order", async () => {
    const first = makeTask({ title: "Earlier removed row", position: 0 });
    const second = makeTask({ title: "Later removed row", position: 1 });
    const remaining = makeTask({ title: "Last row", position: 2 });
    mockedApi.searchTasks
      .mockResolvedValueOnce([first, second, remaining])
      .mockResolvedValueOnce([second, remaining])
      .mockResolvedValueOnce([remaining]);
    mockedApi.completeTask.mockImplementation(async id => ({
      ...(id === first.id ? first : second),
      status: "done",
      revision: 2,
    }));
    const { container } = renderWithProviders(<CompiledSection />);
    await screen.findByText(first.title);
    fireEvent.click(within(screen.getByText(first.title).closest("li")!)
      .getByRole("button", { name: "Erledigt" }));
    await waitFor(() => expect(screen.getAllByText(first.title)).toHaveLength(1));
    fireEvent.click(within(screen.getByText(second.title).closest("li")!)
      .getByRole("button", { name: "Erledigt" }));

    await waitFor(() => expect(container.querySelectorAll("li.task-row[aria-disabled='true']"))
      .toHaveLength(2));
    expect([...container.querySelectorAll(".task-row-title")].map(title => title.textContent))
      .toEqual([first.title, second.title, remaining.title]);
  });
  it("rebases staggered departures without shifting a still-authoritative row", async () => {
    const recurring = makeTask({ title: "Recurring retained row", position: 0, repeatAfterDays: 7 });
    const second = makeTask({ title: "First detached row", position: 1 });
    const third = makeTask({ title: "Second detached row", position: 2 });
    const last = makeTask({ title: "Untouched last row", position: 3 });
    const refreshedRecurring = { ...recurring, revision: 2, status: "actionable" as const };
    mockedApi.searchTasks
      .mockResolvedValueOnce([recurring, second, third, last])
      .mockResolvedValueOnce([refreshedRecurring, second, third, last])
      .mockResolvedValueOnce([refreshedRecurring, third, last])
      .mockResolvedValueOnce([refreshedRecurring, last]);
    mockedApi.completeTask.mockImplementation(async id => id === recurring.id
      ? refreshedRecurring
      : { ...(id === second.id ? second : third), status: "done", revision: 2 });
    const { container } = renderWithProviders(<CompiledSection />);
    await screen.findByText(recurring.title);

    fireEvent.click(within(screen.getByText(recurring.title).closest("li")!)
      .getByRole("button", { name: "Erledigt" }));
    await waitFor(() => expect(within(screen.getByText(recurring.title).closest("li")!)
      .getByRole("status")).toHaveTextContent("Vorkommen erledigt"));
    await new Promise(resolve => setTimeout(resolve, 1_200));

    fireEvent.click(within(screen.getByText(second.title).closest("li")!)
      .getByRole("button", { name: "Erledigt" }));
    await waitFor(() => expect(container.querySelectorAll("li.task-row[aria-disabled='true']"))
      .toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 1_000));

    fireEvent.click(within(screen.getByText(third.title).closest("li")!)
      .getByRole("button", { name: "Erledigt" }));
    await waitFor(() => expect(container.querySelectorAll("li.task-row[aria-disabled='true']"))
      .toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 900));

    expect([...container.querySelectorAll(".task-row-title")].map(title => title.textContent))
      .toEqual([recurring.title, second.title, third.title, last.title]);
    await new Promise(resolve => setTimeout(resolve, 1_200));

    expect([...container.querySelectorAll(".task-row-title")].map(title => title.textContent))
      .toEqual([recurring.title, third.title, last.title]);
    expect(container.querySelectorAll("li.task-row[aria-disabled='true']")).toHaveLength(1);
  });
  it("keeps a pending row inert when membership refresh removes it before the write settles", async () => {
    const task = makeTask({ title: "Refreshed while pending" });
    mockedApi.searchTasks.mockResolvedValueOnce([task]).mockResolvedValue([]);
    let confirm!: (value: typeof task) => void;
    mockedApi.completeTask.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    renderWithProviders(<CompiledSection />);
    await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh server view" }));

    await waitFor(() => expect(screen.getByText(task.title).closest("li")).toHaveAttribute("aria-disabled", "true"));
    let row = screen.getByText(task.title).closest("li")!;
    expect(screen.getAllByText(task.title)).toHaveLength(1);
    expect(within(row).getByRole("status")).toHaveTextContent("Wird erledigt");
    await act(async () => { confirm({ ...task, status: "done", revision: 2 }); });
    expect(screen.getAllByText(task.title)).toHaveLength(1);
    row = screen.getByText(task.title).closest("li")!;
    expect(within(row).getByText(task.title)).toHaveClass("done");
    expect(within(row).getByRole("status")).toHaveTextContent("Erledigt");
  });
  it("confirms a recurring occurrence without presenting the continuing task as done", async () => {
    const task = makeTask({ title: "Weekly task", repeatAfterDays: 7 });
    const refreshed = { ...task, revision: 2, status: "actionable" as const };
    mockedApi.searchTasks.mockResolvedValueOnce([task]).mockResolvedValue([refreshed]);
    mockedApi.completeTask.mockResolvedValue(refreshed);
    renderWithProviders(<CompiledSection />);
    const title = await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));

    expect(await screen.findByText("Vorkommen erledigt")).toBeInTheDocument();
    expect(title).not.toHaveClass("done");
    const row = title.closest("li")!;
    expect(within(row).getByRole("button", { name: "Vorkommen erledigt" })).toHaveClass("occurrence");
    expect(within(row).getByRole("button", { name: "Vorkommen erledigt" })).not.toHaveClass("done");
  });
  it("shows cancellation as a pending cancelled state rather than a completion", async () => {
    const task = makeTask({ title: "Cancel this task" });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.cancelTask.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<CompiledSection openLifecycleTaskId={task.id} />);
    const title = await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Verworfen" }));

    const row = title.closest("li")!;
    expect(row).toHaveClass("task-row-surface-cancelled");
    expect(within(row).getByText(task.title)).toHaveClass("cancelled");
    expect(within(row).getByRole("status")).toHaveTextContent("Wird verworfen");
  });
  it("retires the confirmation timer and task snapshot when the list identity changes", async () => {
    const task = makeTask({ title: "Private old-list row" });
    const replacement = makeTask({ title: "New identity row" });
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done", revision: 2 });
    const { rerender } = renderWithProviders(
      <TaskOutline key="member-one" tasks={[task]} emptyMessage="Empty" />,
    );
    await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    await waitFor(() => expect(within(screen.getByText(task.title).closest("li")!).getByRole("status")).toHaveTextContent("Erledigt"));

    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    rerender(<TaskOutline key="member-two" tasks={[replacement]} emptyMessage="Empty" />);

    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    expect(screen.getByText(replacement.title)).toBeInTheDocument();
    expect(clearTimer).toHaveBeenCalled();
    clearTimer.mockRestore();
  });
  it("releases the task snapshot immediately when a refreshed read denies access", async () => {
    const task = makeTask({ title: "No longer visible task" });
    const denied = new Error("forbidden");
    denied.name = "ApiError";
    Object.assign(denied, { status: 403 });
    mockedApi.searchTasks.mockResolvedValueOnce([task]).mockRejectedValue(denied);
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done", revision: 2 });
    renderWithProviders(<CompiledSection />);
    await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));

    await waitFor(() => expect(screen.queryByText(task.title)).not.toBeInTheDocument());
  });
  it("keeps the authoritative row and shows the rejection without refetching on network failure", async () => {
    const task = makeTask({ title: "Unchanged server row" });
    mockedApi.searchTasks.mockResolvedValue([task]);
    mockedApi.completeTask.mockRejectedValue(new Error("Network failed"));
    renderWithProviders(<CompiledSection />);
    await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    await screen.findByText("Network failed");
    expect(screen.getByText(task.title)).not.toHaveClass("done");
    await waitFor(() => expect(screen.getByRole("button", { name: "Erledigt" })).toBeEnabled());
    expect(mockedApi.searchTasks).toHaveBeenCalledTimes(1);
  });
});
