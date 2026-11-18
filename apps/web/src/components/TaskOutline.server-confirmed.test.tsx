import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { makeTask } from "../test/fixtures";
import { TaskTransitionPresentationProvider } from "../lib/taskTransitionPresentationContext";

vi.mock("../lib/api", () => ({ api: {
  getMembers: vi.fn().mockResolvedValue([]), getTags: vi.fn().mockResolvedValue([]),
  searchTasks: vi.fn(), completeTask: vi.fn(),
} }));
const mockedApi = vi.mocked(api, true);
function CompiledSection() {
  const { data } = useAsync(() => api.searchTasks({}), []);
  const tasks = data ?? [];
  return (
    <TaskTransitionPresentationProvider
      identityKey="compiled-section"
      projection={{
        "compiled-tasks": {
          tasks,
          readSettled: data !== undefined,
          readFailed: false,
        },
      }}
    >
      <TaskOutline
        tasks={tasks}
        emptyMessage="Empty server view"
        transitionSectionId="compiled-tasks"
      />
    </TaskTransitionPresentationProvider>
  );
}

describe("server-confirmed compiled task rows", () => {
  beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });
  it("shows pending feedback, then retains the confirmed source result after refetch", async () => {
    const task = makeTask({ title: "Server row" });
    mockedApi.searchTasks.mockResolvedValueOnce([task]).mockResolvedValue([]);
    let confirm!: (value: typeof task) => void;
    mockedApi.completeTask.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    renderWithProviders(<CompiledSection />);
    await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    expect(screen.getByText("Wird erledigt …")).toBeInTheDocument();
    expect(screen.getByText(task.title)).not.toHaveClass("done");
    expect(screen.getByRole("button", { name: "Erledigt" })).toBeDisabled();
    await act(async () => { confirm({ ...task, status: "done", revision: 2 }); });
    expect(await screen.findByText("Erledigt")).toBeInTheDocument();
    expect(screen.getByText(task.title)).toBeInTheDocument();
    expect(screen.getByText(task.title).closest("li")).toHaveAttribute("aria-disabled", "true");
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
