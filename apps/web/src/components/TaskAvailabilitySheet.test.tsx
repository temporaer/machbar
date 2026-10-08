import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { makeTask } from "../test/fixtures";
import { householdCalendarDateTimeToRevisitAt } from "@machbar/shared";
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
 * Compatibility coverage for the old availability import: it now renders
 * the unified planning sheet and commits all temporal fields together.
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

  it("writes a same-day 'In einer Weile' availability gate from the unified sheet", async () => {
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 40 }));
    const task = makeTask({ id: 40, title: "Wäsche aufhängen", scheduledDate: "2026-09-14" });
    const onClose = vi.fn();
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "In einer Weile" }));
    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(40, {
        revisitAt: expect.any(String),
        scheduledDate: null,
        dueDate: null,
        expectedRevision: 1,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("writes a same-day 'Heute Abend' availability gate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 19, 18, 0));
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 41 }));
    const task = makeTask({ id: 41, title: "Anruf zurückgeben" });
    const onClose = vi.fn();
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={onClose} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Heute Abend" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fertig" }));
    });

    expect(mockedApi.updateTask).toHaveBeenCalledWith(41, {
      revisitAt: expect.any(String),
      scheduledDate: null,
      dueDate: null,
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

  it("sets a future date (Morgen) as availability", async () => {
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 42 }));
    const task = makeTask({ id: 42, title: "Steuer einreichen" });
    const onClose = vi.fn();
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getAllByRole("button", { name: "Morgen" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(42, {
        revisitAt: expect.any(String),
        scheduledDate: null,
        dueDate: null,
        expectedRevision: 1,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("clears an existing availability gate", async () => {
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 44, revisitAt: null }));
    const task = makeTask({ id: 44, title: "Handwerker beauftragen", revisitAt: "2026-09-19T18:00:00.000Z" });
    const onClose = vi.fn();
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Wiedervorlage entfernen" }));
    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(44, {
        revisitAt: null,
        scheduledDate: null,
        dueDate: null,
        expectedRevision: 1,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("requires both a custom date and time before confirming", async () => {
    const task = makeTask({ id: 45, title: "Termin abstimmen" });
    renderWithProviders(<TaskAvailabilitySheet task={task} onClose={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Wiedervorlage"), "morgen");
    await userEvent.tab();
    await userEvent.clear(screen.getByLabelText("Uhrzeit"));

    expect(screen.getByRole("button", { name: "Fertig" })).toBeDisabled();
  });

  it.each(["2026-03-29", "2026-10-25"])(
    "rejects nonexistent or ambiguous household-local times on %s without submitting a clear",
    async (date) => {
      const task = makeTask({
        id: 47,
        revisitAt: "2026-03-28T01:30:00.000Z",
      });
      const { container } = renderWithProviders(
        <TaskAvailabilitySheet task={task} onClose={vi.fn()} />,
      );
      const picker = container.querySelector('input[type="date"]')!;
      fireEvent.change(picker, { target: { value: date } });
      fireEvent.change(screen.getByLabelText("Uhrzeit"), {
        target: { value: "02:30" },
      });

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Diese lokale Uhrzeit ist in der Haushaltszeitzone ungültig oder doppeldeutig.",
      );
      expect(screen.getByLabelText("Uhrzeit")).toHaveValue("02:30");
      expect(screen.getByRole("button", { name: "Fertig" })).toBeDisabled();
      expect(mockedApi.updateTask).not.toHaveBeenCalled();
    },
  );

  it("accepts a valid post-overlap time as the correct household-zone instant", async () => {
    const task = makeTask({ id: 48, revisitAt: "2026-10-24T00:30:00.000Z" });
    const { container } = renderWithProviders(
      <TaskAvailabilitySheet task={task} onClose={vi.fn()} />,
    );
    fireEvent.change(container.querySelector('input[type="date"]')!, {
      target: { value: "2026-10-25" },
    });
    fireEvent.change(screen.getByLabelText("Uhrzeit"), {
      target: { value: "03:30" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));

    expect(mockedApi.updateTask).toHaveBeenCalledWith(48, {
      revisitAt: householdCalendarDateTimeToRevisitAt(
        "2026-10-25",
        "03:30",
        "Europe/Berlin",
      ),
      scheduledDate: null,
      dueDate: null,
      expectedRevision: 1,
    });
  });

  it("uses the same unified planning workflow for task.availability", async () => {
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
    expect(await screen.findByLabelText("Wiedervorlage")).toBeInTheDocument();
    expect(screen.getByLabelText("Geplant für")).toBeInTheDocument();
    expect(screen.getByLabelText("Fällig bis")).toBeInTheDocument();
  });
});
