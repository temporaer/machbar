import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { makeTask } from "../test/fixtures";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { TaskAvailabilitySheet } from "./TaskAvailabilitySheet";

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
 * Coverage for the fixed row rail's `Ab …` sheet: every preset writes the
 * persistent task `notBeforeAt` availability gate and never touches
 * `scheduledDate`, which remains owned by `TaskPlanSheet`.
 */
describe("TaskAvailabilitySheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a same-day 'In einer Weile' availability gate without touching scheduledDate", async () => {
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 40 }));
    const task = makeTask({ id: 40, title: "Wäsche aufhängen", scheduledDate: "2026-09-14" });
    const onClose = vi.fn();
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "In einer Weile" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(40, {
        notBeforeAt: expect.any(String),
        notBeforeDate: expect.any(String),
        expectedRevision: 1,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("writes a same-day 'Heute Abend' availability gate without touching scheduledDate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 19, 18, 0));
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 41 }));
    const task = makeTask({ id: 41, title: "Anruf zurückgeben" });
    const onClose = vi.fn();
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={onClose} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Heute Abend" }));
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(41, {
      notBeforeAt: expect.any(String),
      notBeforeDate: expect.any(String),
      expectedRevision: 1,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("hides 'Heute Abend' after today's evening target has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 19, 21, 0));

    renderWithProviders(
      <TaskAvailabilitySheet
        task={makeTask({ id: 46, title: "Später Anruf" })}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Heute Abend" }),
    ).not.toBeInTheDocument();
  });

  it("sets a future date (Morgen) as availability, not a scheduledDate commit", async () => {
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 42 }));
    const task = makeTask({ id: 42, title: "Steuer einreichen" });
    const onClose = vi.fn();
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(42, {
        notBeforeAt: expect.any(String),
        notBeforeDate: expect.any(String),
        expectedRevision: 1,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("clears an existing availability gate", async () => {
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 44, notBeforeAt: null }));
    const task = makeTask({ id: 44, title: "Handwerker beauftragen", notBeforeAt: "2026-09-19T18:00:00.000Z" });
    const onClose = vi.fn();
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Ab-Datum entfernen" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(44, {
        notBeforeAt: null,
        notBeforeDate: null,
        expectedRevision: 1,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("requires both a custom date and time before confirming", async () => {
    const task = makeTask({ id: 45, title: "Termin abstimmen" });
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Anderes Datum"), "morgen");
    await userEvent.tab();
    await userEvent.clear(screen.getByLabelText("Uhrzeit"));

    expect(screen.getByRole("button", { name: "Fertig" })).toBeDisabled();
  });

  it("escapes into the full task.plan workflow via 'Einplanen / Deadline …'", async () => {
    const task = makeTask({ id: 43, title: "Handwerker beauftragen" });
    mockedApi.getTask.mockResolvedValue(task);

    function Harness() {
      const workflow = useTaskWorkflow();
      return (
        <div>
          <button type="button" onClick={() => workflow.open("availability", 43)}>
            open availability
          </button>
          <TaskWorkflowHost />
        </div>
      );
    }
    renderWithProviders(<Harness />);

    await userEvent.click(screen.getByRole("button", { name: "open availability" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Einplanen / Deadline …" }),
    );

    expect(await screen.findByLabelText("Wann nimmst du dir das vor?")).toBeInTheDocument();
  });
});
