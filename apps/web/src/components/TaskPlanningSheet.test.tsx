import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
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
let originalScrollIntoViewDescriptor: PropertyDescriptor | undefined;

function card(name: string) {
  return screen.getByRole("heading", { name }).closest("section") as HTMLElement;
}

function stubScrollIntoView(
  implementation: (this: HTMLElement, options?: ScrollIntoViewOptions) => void,
) {
  const mock = vi.fn(implementation);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: mock,
  });
  return mock;
}

describe("TaskPlanningSheet", () => {
  beforeEach(() => {
    originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
  });

  afterEach(() => {
    if (originalScrollIntoViewDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        originalScrollIntoViewDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
    vi.restoreAllMocks();
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

  it("unmarks a stored preset while the revisit date contains invalid text", async () => {
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

    const dateInput = screen.getByLabelText("Datum");
    const tomorrow = within(card("Wiedervorlage")).getByRole("button", {
      name: "Morgen",
    });
    expect(tomorrow).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(dateInput, { target: { value: "kein Datum" } });
    fireEvent.blur(dateInput);

    expect(tomorrow).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();

    fireEvent.change(dateInput, { target: { value: "10.10.2026" } });
    fireEvent.blur(dateInput);

    expect(tomorrow).toHaveAttribute("aria-pressed", "true");
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

  it("resets the actual sheet scroll position only when entering neutral planning", () => {
    const scrollIntoView = stubScrollIntoView(function () {});
    const task = makeTask();
    const { rerender } = renderWithProviders(
      <TaskPlanningSheet
        task={task}
        onClose={vi.fn()}
      />,
    );

    expect(card("Geplant für")).not.toHaveClass("task-planning-card-active");
    expect(scrollIntoView).not.toHaveBeenCalled();
    const sheet = screen.getByRole("dialog");
    sheet.scrollTop = 120;
    rerender(<TaskPlanningSheet task={task} onClose={vi.fn()} />);
    expect(sheet.scrollTop).toBe(120);

    rerender(
      <TaskPlanningSheet
        task={task}
        initialTarget="scheduled"
        onClose={vi.fn()}
      />,
    );
    expect(card("Geplant für")).toHaveClass("task-planning-card-active");
    scrollIntoView.mockClear();

    rerender(
      <TaskPlanningSheet task={task} onClose={vi.fn()} />,
    );
    expect(card("Geplant für")).not.toHaveClass("task-planning-card-active");
    expect(sheet.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls to an opened deadline only after the target card is expanded", () => {
    const observed: Array<{
      element: HTMLElement;
      options: ScrollIntoViewOptions;
      hasTextbox: boolean;
    }> = [];
    const scrollIntoView = stubScrollIntoView(function (options) {
      observed.push({
        element: this,
        options: options ?? {},
        hasTextbox: Boolean(within(this).queryByRole("textbox")),
      });
    });
    const task = makeTask();
    const { rerender } = renderWithProviders(
      <TaskPlanningSheet
        task={task}
        initialTarget="scheduled"
        onClose={vi.fn()}
      />,
    );

    scrollIntoView.mockClear();
    observed.length = 0;
    rerender(
      <TaskPlanningSheet
        task={task}
        initialTarget="deadline"
        onClose={vi.fn()}
      />,
    );

    expect(observed).toHaveLength(1);
    expect(observed[0]?.element).toBe(card("Deadline"));
    expect(observed[0]?.options).toEqual({
      block: "nearest",
      behavior: "auto",
    });
    expect(observed[0]?.hasTextbox).toBe(true);
  });

  it("scrolls only the selected card once and preserves manual selection on rerender", () => {
    const observed: HTMLElement[] = [];
    const scrollIntoView = stubScrollIntoView(function () {
      observed.push(this);
    });
    const task = makeTask();
    const { rerender } = renderWithProviders(
      <TaskPlanningSheet
        task={task}
        initialTarget="scheduled"
        onClose={vi.fn()}
      />,
    );

    scrollIntoView.mockClear();
    observed.length = 0;
    rerender(
      <TaskPlanningSheet
        task={task}
        initialTarget="availability"
        onClose={vi.fn()}
      />,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(card("Wiedervorlage"));

    fireEvent.pointerDown(card("Deadline"));
    rerender(
      <TaskPlanningSheet
        task={task}
        initialTarget="availability"
        onClose={vi.fn()}
      />,
    );
    expect(observed).toHaveLength(1);
    expect(card("Deadline")).toHaveClass("task-planning-card-active");
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
