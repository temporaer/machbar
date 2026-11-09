import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({ api: {
  getMembers: vi.fn().mockResolvedValue([]), getTags: vi.fn().mockResolvedValue([]),
  completeTask: vi.fn(),
} }));
const mockedApi = vi.mocked(api, true);

describe("authoritative task row rendering", () => {
  beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });
  it("renders refreshed descendant values and membership without a held parent snapshot", () => {
    const child = makeTask({ id: 2, title: "Child", blocked: true });
    const task = makeTask({ title: "Parent", children: [child] });
    const { rerender } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Empty" />);
    expect(screen.getByText("Child")).toBeInTheDocument();
    rerender(<TaskOutline tasks={[{ ...task, title: "Fresh parent", children: [] }]} emptyMessage="Empty" />);
    expect(screen.queryByText("Child")).not.toBeInTheDocument();
    expect(screen.getByText("Fresh parent")).toBeInTheDocument();
  });
  it.each(["leave_open", "complete_children", "cancel_children"] as const)(
    "forwards the explicit %s descendant policy without changing visible domain state before refetch",
    async policy => {
      const task = makeTask({ title: "Parent", children: [makeTask({ id: 2, title: "Child" })] });
      mockedApi.completeTask.mockResolvedValue({ ...task, status: "done", revision: 2 });
      const { useTaskActions } = await import("../lib/useTaskActions");
      function Controls() {
        const actions = useTaskActions();
        return <button onClick={() => void actions.complete(task, policy)}>Confirm policy</button>;
      }
      renderWithProviders(<><TaskOutline tasks={[task]} emptyMessage="Empty" /><Controls /></>);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm policy" })));
      expect(mockedApi.completeTask).toHaveBeenCalledWith(task.id, policy, undefined, task.revision);
      expect(screen.getByText("Parent")).not.toHaveClass("done");
      expect(screen.getByText("Child")).not.toHaveClass("done");
    },
  );
});
