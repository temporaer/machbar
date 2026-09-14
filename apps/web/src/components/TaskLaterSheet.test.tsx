import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { makeTask } from "../test/fixtures";
import { readSnoozeEntries } from "../lib/taskSnooze";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { TaskLaterSheet } from "./TaskLaterSheet";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

/**
 * Coverage for the fixed row rail's `Später` sheet
 * (`TaskLaterSheet.tsx`): same-day choices ("In einer Weile"/"Heute
 * Abend") must only write the client-only, member-scoped snooze
 * (`taskSnooze.ts`) and never touch `scheduledDate`, while a future date
 * choice commits through the same `scheduledDate` patch `TaskPlanSheet`
 * uses. See `taskSnooze.test.ts` for the underlying storage primitive's
 * own unit coverage.
 */
describe("TaskLaterSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
  });

  it("writes a same-day 'In einer Weile' snooze without touching scheduledDate", async () => {
    const task = makeTask({ id: 40, title: "Wäsche aufhängen", scheduledDate: "2026-09-14" });
    const onClose = vi.fn();
    renderWithProviders(<TaskLaterSheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "In einer Weile" }));

    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    const entries = readSnoozeEntries(null);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ taskId: 40 });
    // Still today: the snooze is a same-day defer, not a reschedule.
    expect(new Date(entries[0]!.until).toISOString().slice(0, 10)).toBe(
      new Date().toISOString().slice(0, 10),
    );
  });

  it("writes a same-day 'Heute Abend' snooze without touching scheduledDate", async () => {
    const task = makeTask({ id: 41, title: "Anruf zurückgeben" });
    const onClose = vi.fn();
    renderWithProviders(<TaskLaterSheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Heute Abend" }));

    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(readSnoozeEntries(null)).toHaveLength(1);
  });

  it("schedules a future date (Morgen) as a real scheduledDate commit, not a snooze", async () => {
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 42 }));
    const task = makeTask({ id: 42, title: "Steuer einreichen" });
    const onClose = vi.fn();
    renderWithProviders(<TaskLaterSheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(42, {
        scheduledDate: expect.any(String),
        expectedRevision: 1,
      }),
    );
    expect(onClose).toHaveBeenCalled();
    expect(readSnoozeEntries(null)).toHaveLength(0);
  });

  it("escapes into the full task.plan workflow via 'Weitere Planungsoptionen …'", async () => {
    const task = makeTask({ id: 43, title: "Handwerker beauftragen" });
    mockedApi.getTask.mockResolvedValue(task);

    function Harness() {
      const workflow = useTaskWorkflow();
      return (
        <div>
          <button type="button" onClick={() => workflow.open("later", 43)}>
            open later
          </button>
          <TaskWorkflowHost />
        </div>
      );
    }
    renderWithProviders(<Harness />);

    await userEvent.click(screen.getByRole("button", { name: "open later" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Weitere Planungsoptionen …" }),
    );

    expect(await screen.findByLabelText("Wann willst du das angehen?")).toBeInTheDocument();
  });
});
