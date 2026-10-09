import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { householdCalendarDateTimeToRevisitAt } from "@machbar/shared";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeTask } from "../test/fixtures";
import { TaskPlanningSheet } from "./TaskPlanningSheet";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function card(name: string) {
  return screen.getByRole("heading", { name }).closest("section") as HTMLElement;
}

describe("TaskPlanningSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps saving disabled when only the time changes after an invalid date draft", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TaskPlanningSheet
        task={makeTask({
          revisitAt: householdCalendarDateTimeToRevisitAt(
            "2026-10-10",
            "06:00",
            "Europe/Berlin",
          ),
        })}
        onClose={vi.fn()}
      />,
    );

    const dateInput = screen.getByLabelText("Datum");
    await user.clear(dateInput);
    await user.type(dateInput, "kein Datum");
    await user.tab();
    await user.clear(screen.getByLabelText("Uhrzeit"));
    await user.type(screen.getByLabelText("Uhrzeit"), "07:00");

    expect(dateInput).toHaveValue("kein Datum");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();

    await user.clear(dateInput);
    await user.type(dateInput, "10.10.2026");
    await user.tab();

    expect(screen.getByRole("button", { name: "Speichern" })).not.toBeDisabled();
  });

  it("marks a matching stored revisit preset without editing the draft", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T07:00:00.000Z"));
    renderWithProviders(
      <TaskPlanningSheet
        task={makeTask({
          revisitAt: householdCalendarDateTimeToRevisitAt(
            "2026-10-10",
            "06:00",
            "Europe/Berlin",
          ),
        })}
        onClose={vi.fn()}
      />,
    );

    expect(
      within(card("Wiedervorlage")).getByRole("button", { name: "Morgen" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("keeps only the current replacement notice while dates are replaced", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TaskPlanningSheet
        task={makeTask({ scheduledDate: "2026-10-10" })}
        onClose={vi.fn()}
      />,
    );

    await user.click(
      within(card("Wiedervorlage")).getByRole("button", { name: "Morgen" }),
    );
    expect(
      within(card("Geplant für")).getByText(/Planung für/),
    ).toBeInTheDocument();

    await user.click(
      within(card("Geplant für")).getByRole("button", { name: "Heute" }),
    );
    expect(
      within(card("Geplant für")).queryByText(/Planung für/),
    ).not.toBeInTheDocument();
    expect(
      within(card("Wiedervorlage")).getByText(/Wiedervorlage für/),
    ).toBeInTheDocument();
  });

  it("synchronizes active cards and deadline expansion when the target changes", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const task = makeTask();
    const { rerender } = renderWithProviders(
      <TaskPlanningSheet
        task={task}
        initialTarget="scheduled"
        onClose={vi.fn()}
      />,
    );

    expect(card("Geplant für")).toHaveClass("task-planning-card-active");
    rerender(
      <TaskPlanningSheet
        task={task}
        initialTarget="deadline"
        onClose={vi.fn()}
      />,
    );
    expect(card("Deadline")).toHaveClass("task-planning-card-active");
    expect(
      within(card("Deadline")).getByRole("textbox"),
    ).toBeInTheDocument();

    rerender(
      <TaskPlanningSheet task={task} onClose={vi.fn()} />,
    );
    expect(card("Deadline")).not.toHaveClass("task-planning-card-active");
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("expands and removes an empty deadline without mutating", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TaskPlanningSheet task={makeTask()} onClose={vi.fn()} />,
    );

    const deadline = card("Deadline");
    expect(within(deadline).queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(
      within(deadline).getByRole("button", { name: "+ Deadline hinzufügen" }),
    );
    expect(within(deadline).getByRole("textbox")).toBeInTheDocument();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();

    await user.type(within(deadline).getByRole("textbox"), "20.10.2026");
    await user.tab();
    await user.click(
      within(deadline).getByRole("button", { name: "Deadline entfernen" }),
    );
    expect(within(deadline).queryByRole("textbox")).not.toBeInTheDocument();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });
});
