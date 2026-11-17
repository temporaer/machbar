import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { makeTask } from "../test/fixtures";
import { useInteractionScope } from "../lib/interactionScope";

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
    expect(within(title.closest("li")!).getByRole("status")).toHaveTextContent("Wird erledigt");
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
    expect(within(title.closest("li")!).getByRole("button", { name: "Wieder öffnen" })).toBeDisabled();
    await new Promise(resolve => setTimeout(resolve, 2_500));
    expect(screen.getByText(task.title)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(task.title)).not.toBeInTheDocument());
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    expect(screen.getByText("Empty server view")).toBeInTheDocument();
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
