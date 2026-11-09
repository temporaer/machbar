import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({ api: {
  getMembers: vi.fn().mockResolvedValue([]), getTags: vi.fn().mockResolvedValue([]),
  searchTasks: vi.fn(), completeTask: vi.fn(),
} }));
const mockedApi = vi.mocked(api, true);
function CompiledSection() {
  const { data } = useAsync(() => api.searchTasks({}), []);
  return <TaskOutline tasks={data ?? []} emptyMessage="Empty server view" />;
}

describe("server-confirmed compiled task rows", () => {
  beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });
  it("keeps server content pending, then removes a completed row on refetch without a timer", async () => {
    const task = makeTask({ title: "Server row" });
    mockedApi.searchTasks.mockResolvedValueOnce([task]).mockResolvedValue([]);
    let confirm!: (value: typeof task) => void;
    mockedApi.completeTask.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    renderWithProviders(<CompiledSection />);
    await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    expect(screen.getByText(task.title)).not.toHaveClass("done");
    expect(screen.getByRole("button", { name: "Erledigt" })).toBeDisabled();
    await act(async () => { confirm({ ...task, status: "done", revision: 2 }); });
    await screen.findByText("Empty server view");
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
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
