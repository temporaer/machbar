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

  it("keeps the waiting card neutral and non-dirty until a reason is entered", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskPlanningSheet task={makeTask()} onClose={vi.fn()} />);

    expect(card("Wartet auf")).not.toHaveClass("task-planning-card-active");
    expect(
      within(card("Wartet auf")).queryByRole("textbox"),
    ).not.toBeInTheDocument();
    await user.click(
      within(card("Wartet auf")).getByRole("button", {
        name: "+ Warten hinzufügen",
      }),
    );

    expect(within(card("Wartet auf")).getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("opens the targeted waiting card without focusing its input", () => {
    const observed: Array<{ element: HTMLElement; hasTextbox: boolean }> = [];
    const scrollIntoView = stubScrollIntoView(function () {
      observed.push({
        element: this,
        hasTextbox: Boolean(within(this).queryByRole("textbox")),
      });
    });
    renderWithProviders(
      <TaskPlanningSheet
        task={makeTask()}
        initialTarget="waiting"
        onClose={vi.fn()}
      />,
    );

    expect(card("Wartet auf")).toHaveClass("task-planning-card-active");
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "auto",
    });
    expect(observed).toEqual([
      { element: card("Wartet auf"), hasTextbox: true },
    ]);
    expect(document.activeElement).not.toBe(
      within(card("Wartet auf")).getByRole("textbox"),
    );
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
  });

  it("saves a new waiting reason atomically with planning fields", async () => {
    const user = userEvent.setup();
    const task = makeTask({ revision: 7 });
    mockedApi.updateTask.mockResolvedValue({
      ...task,
      revision: 8,
      externalWait: { waitingFor: "Werkstatt", revisitDate: null },
    });
    renderWithProviders(<TaskPlanningSheet task={task} onClose={vi.fn()} />);

    await user.click(
      within(card("Wartet auf")).getByRole("button", {
        name: "+ Warten hinzufügen",
      }),
    );
    await user.type(
      within(card("Wartet auf")).getByRole("textbox"),
      "  Werkstatt  ",
    );
    await user.click(
      within(card("Deadline")).getByRole("button", {
        name: "+ Deadline hinzufügen",
      }),
    );
    await user.type(within(card("Deadline")).getByRole("textbox"), "20.10.2026");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await vi.waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({
          externalWait: { waitingFor: "Werkstatt" },
          expectedRevision: task.revision,
        }),
      ),
    );
  });

  it("allows unrelated date changes after opening an empty waiting editor", async () => {
    const user = userEvent.setup();
    const task = makeTask({ revision: 3 });
    mockedApi.updateTask.mockResolvedValue({ ...task, revision: 4 });
    renderWithProviders(<TaskPlanningSheet task={task} onClose={vi.fn()} />);

    await user.click(
      within(card("Wartet auf")).getByRole("button", {
        name: "+ Warten hinzufügen",
      }),
    );
    await user.click(
      within(card("Deadline")).getByRole("button", {
        name: "+ Deadline hinzufügen",
      }),
    );
    await user.type(within(card("Deadline")).getByRole("textbox"), "20.10.2026");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await vi.waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(
        task.id,
        expect.not.objectContaining({ externalWait: expect.anything() }),
      ),
    );
  });

  it("clears the visible revisit when ending a wait and restores it on undo", async () => {
    const user = userEvent.setup();
    const revisitAt = householdCalendarDateTimeToRevisitAt(
      "2026-10-20",
      "06:00",
      "Europe/Berlin",
    );
    renderWithProviders(
      <TaskPlanningSheet
        task={makeTask({
          revisitAt,
          externalWait: { waitingFor: "Amt", revisitDate: revisitAt },
        })}
        onClose={vi.fn()}
      />,
    );

    await user.click(
      within(card("Wartet auf")).getByRole("button", { name: "Warten beenden" }),
    );
    expect(within(card("Wiedervorlage")).getByLabelText("Datum")).toBeDisabled();
    expect(within(card("Wiedervorlage")).getByLabelText("Datum")).toHaveValue("");
    expect(
      within(card("Wartet auf")).getByText("Die zugehörige Wiedervorlage wird entfernt."),
    ).toBeInTheDocument();
    expect(within(card("Geplant für")).getByRole("textbox")).toBeInTheDocument();
    await user.click(
      within(card("Wartet auf")).getByRole("button", { name: "Rückgängig" }),
    );
    expect(within(card("Wiedervorlage")).getByLabelText("Datum")).toHaveValue(
      "20.10.2026",
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("keeps a legacy empty wait during unrelated date edits", async () => {
    const user = userEvent.setup();
    const task = makeTask({
      externalWait: { waitingFor: "", revisitDate: null },
      revision: 2,
    });
    mockedApi.updateTask.mockResolvedValue({ ...task, revision: 3 });
    renderWithProviders(<TaskPlanningSheet task={task} onClose={vi.fn()} />);

    await user.click(
      within(card("Deadline")).getByRole("button", {
        name: "+ Deadline hinzufügen",
      }),
    );
    await user.type(within(card("Deadline")).getByRole("textbox"), "20.10.2026");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await vi.waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(
        task.id,
        expect.not.objectContaining({ externalWait: null }),
      ),
    );
  });

  it("blocks saving when an existing waiting reason is explicitly cleared", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TaskPlanningSheet
        task={makeTask({
          externalWait: { waitingFor: "Amt", revisitDate: null },
        })}
        onClose={vi.fn()}
      />,
    );

    const input = within(card("Wartet auf")).getByRole("textbox");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bitte gib an, worauf die Aufgabe wartet.",
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("keeps revisit as the active card when its hint is selected", async () => {
    const user = userEvent.setup();
    const scrollIntoView = stubScrollIntoView(function () {});
    renderWithProviders(
      <TaskPlanningSheet
        task={makeTask({
          externalWait: { waitingFor: "Amt", revisitDate: null },
        })}
        onClose={vi.fn()}
      />,
    );

    await user.click(
      within(card("Wartet auf")).getByRole("button", {
        name: "Wiedervorlage setzen",
      }),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "auto",
    });
    expect(card("Wiedervorlage")).toHaveClass("task-planning-card-active");
    expect(card("Wartet auf")).not.toHaveClass("task-planning-card-active");
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("blocks a schedule and revisit conflict after removing a new wait", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskPlanningSheet task={makeTask()} onClose={vi.fn()} />);

    await user.click(
      within(card("Wartet auf")).getByRole("button", {
        name: "+ Warten hinzufügen",
      }),
    );
    await user.type(
      within(card("Wartet auf")).getByRole("textbox"),
      "Werkstatt",
    );
    await user.type(
      within(card("Geplant für")).getByRole("textbox"),
      "10.10.2026",
    );
    await user.tab();
    await user.click(
      within(card("Wiedervorlage")).getByRole("button", { name: "Morgen" }),
    );
    await user.click(
      within(card("Wartet auf")).getByRole("button", { name: "Entfernen" }),
    );

    expect(
      within(card("Wartet auf")).getByRole("alert"),
    ).toHaveTextContent(
      "Ohne externes Warten können Planung und Wiedervorlage nicht gleichzeitig gesetzt bleiben.",
    );
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();

    await user.click(
      within(card("Geplant für")).getByRole("button", {
        name: "Planungsdatum entfernen",
      }),
    );
    expect(within(card("Wartet auf")).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).not.toBeDisabled();
  });

  it("clearing a new waiting reason exposes the same date conflict", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskPlanningSheet task={makeTask()} onClose={vi.fn()} />);

    await user.click(
      within(card("Wartet auf")).getByRole("button", {
        name: "+ Warten hinzufügen",
      }),
    );
    const waitingInput = within(card("Wartet auf")).getByRole("textbox");
    await user.type(waitingInput, "Werkstatt");
    await user.type(
      within(card("Geplant für")).getByRole("textbox"),
      "10.10.2026",
    );
    await user.tab();
    await user.click(
      within(card("Wiedervorlage")).getByRole("button", { name: "Morgen" }),
    );
    await user.clear(waitingInput);

    expect(
      within(card("Wartet auf")).getByRole("alert"),
    ).toHaveTextContent(
      "Ohne externes Warten können Planung und Wiedervorlage nicht gleichzeitig gesetzt bleiben.",
    );
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();

    await user.type(waitingInput, "Werkstatt");
    expect(within(card("Wartet auf")).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).not.toBeDisabled();
  });
});
