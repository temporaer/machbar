import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
    getTask: vi.fn(),
    getProject: vi.fn(),
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

  it("keeps the planning draft and retries with a refreshed task revision after a conflict", async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 204, revision: 4 });
    mockedApi.getTask.mockResolvedValue({ ...task, revision: 5 } as never);
    mockedApi.updateTask
      .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_write_conflict" }))
      .mockResolvedValueOnce({ ...task, revision: 6 } as never);
    renderWithProviders(<TaskPlanningSheet task={task} onClose={vi.fn()} />);

    await user.click(within(card("Deadline")).getByRole("button", { name: "+ Deadline hinzufügen" }));
    await user.type(within(card("Deadline")).getByRole("textbox"), "20.10.2026");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.getTask).toHaveBeenCalledWith(task.id));
    expect(within(card("Deadline")).getByRole("textbox")).toHaveValue("20.10.2026");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.updateTask.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 4 });
    expect(mockedApi.updateTask.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 5,
      dueDate: "2026-10-20",
    });
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

  it("opens reminders directly in planning and commits recurrence, first date, and reminders together", async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 310, status: "someday", scheduledDate: null, reminders: [] });
    mockedApi.updateTask.mockResolvedValue({
      ...task,
      status: "actionable",
      scheduledDate: "2026-12-01",
      repeatAfterDays: 14,
      allowedDeviationDays: 2,
      dueDate: "2026-12-03",
      revision: task.revision + 1,
    } as never);
    const onClose = vi.fn();
    const scrollIntoView = stubScrollIntoView(function () {});
    renderWithProviders(
      <TaskPlanningSheet task={task} initialTarget="reminders" onClose={onClose} />,
    );

    expect(card("Erinnerungen")).toHaveClass("task-planning-card-active");
    expect(scrollIntoView).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Morgen früh" }));
    await user.click(within(card("Geplant für")).getByRole("checkbox", { name: "Wiederholung" }));

    const firstDate = within(card("Geplant für")).getByLabelText("Geplant für");
    fireEvent.change(firstDate, { target: { value: "01.12.2026" } });
    fireEvent.blur(firstDate);
    const interval = within(card("Geplant für")).getByLabelText("Wiederholen nach Tagen");
    await user.clear(interval);
    await user.type(interval, "14");
    const deviation = within(card("Geplant für")).getByLabelText("Erlaubte Abweichung in Tagen");
    await user.clear(deviation);
    await user.type(deviation, "2");

    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(1));
    expect(mockedApi.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      scheduledDate: "2026-12-01",
      repeatAfterDays: 14,
      allowedDeviationDays: 2,
      reminders: [{ kind: "absolute", at: expect.any(String) }],
      expectedRevision: task.revision,
    }));
    expect(mockedApi.updateTask.mock.calls[0]?.[1]).not.toHaveProperty("dueDate");
    expect(onClose).toHaveBeenCalled();
  });

  it("requires the first scheduled date before recurrence can be saved and cancellation persists nothing", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <TaskPlanningSheet task={makeTask({ scheduledDate: null })} initialTarget="recurrence" onClose={onClose} />,
    );

    const recurrence = within(card("Geplant für")).getByRole("checkbox", { name: "Wiederholung" });
    expect(card("Geplant für")).toHaveClass("task-planning-card-active");
    await user.click(recurrence);
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(within(card("Geplant für")).getByRole("alert")).toHaveTextContent("Lege zuerst einen geplanten Termin fest.");
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps recurrence and reminder drafts across a stale task revision retry", async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 311, revision: 4, status: "someday", scheduledDate: null, reminders: [] });
    mockedApi.getTask.mockResolvedValue({ ...task, revision: 5 } as never);
    mockedApi.updateTask
      .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_write_conflict" }))
      .mockResolvedValueOnce({ ...task, revision: 6, status: "actionable" } as never);
    renderWithProviders(<TaskPlanningSheet task={task} initialTarget="recurrence" onClose={vi.fn()} />);

    await user.click(within(card("Geplant für")).getByRole("checkbox", { name: "Wiederholung" }));
    const firstDate = within(card("Geplant für")).getByLabelText("Geplant für");
    fireEvent.change(firstDate, { target: { value: "01.12.2026" } });
    fireEvent.blur(firstDate);
    await user.click(within(card("Erinnerungen")).getByRole("button", { name: "+ Erinnerung" }));
    await user.click(within(card("Erinnerungen")).getByRole("button", { name: "Morgen früh" }));
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.getTask).toHaveBeenCalledWith(task.id));
    expect(within(card("Geplant für")).getByLabelText("Wiederholen nach Tagen")).toHaveValue(7);
    expect(within(card("Erinnerungen")).getByRole("button", { name: "Erinnerung entfernen" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.updateTask.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 4 });
    expect(mockedApi.updateTask.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 5,
      scheduledDate: "2026-12-01",
      repeatAfterDays: 7,
      reminders: [{ kind: "absolute", at: expect.any(String) }],
    });
  });

  it("recollects activation decisions when a planning draft changes and retries the full draft", async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 312, revision: 2, status: "someday", projectId: 45, scheduledDate: null, reminders: [] });
    const missingDriver = () => Object.assign(new Error("decision required"), {
      code: "project_commitment_resolution_required",
      details: {
        projects: [{ projectId: 45, title: "Heizung", revision: 8, ownerMemberId: null, required: ["driver"] }],
        expectedProjects: [{ projectId: 45, revision: 8 }],
        targetRevision: 8,
      },
    });
    mockedApi.getMembers.mockResolvedValue([{ id: 9, name: "Rae" }] as never);
    mockedApi.updateTask
      .mockRejectedValueOnce(missingDriver())
      .mockRejectedValueOnce(missingDriver())
      .mockResolvedValueOnce({ ...task, status: "actionable", revision: 3 } as never);
    renderWithProviders(<TaskPlanningSheet task={task} initialTarget="recurrence" onClose={vi.fn()} />);

    await user.click(within(card("Geplant für")).getByRole("checkbox", { name: "Wiederholung" }));
    const firstDate = within(card("Geplant für")).getByLabelText("Geplant für");
    fireEvent.change(firstDate, { target: { value: "01.12.2026" } });
    fireEvent.blur(firstDate);
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    const driver = await screen.findByLabelText("Verantwortlich für „Heizung“");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    await user.selectOptions(driver, "9");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    const interval = within(card("Geplant für")).getByLabelText("Wiederholen nach Tagen");
    await user.clear(interval);
    await user.type(interval, "14");
    expect(screen.queryByLabelText("Verantwortlich für „Heizung“")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.updateTask.mock.calls[1]?.[1]).not.toHaveProperty("activationResolution");

    await user.selectOptions(await screen.findByLabelText("Verantwortlich für „Heizung“"), "9");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(3));
    const finalPatch = mockedApi.updateTask.mock.calls[2]?.[1] as Record<string, unknown>;
    expect(finalPatch).toMatchObject({
      scheduledDate: "2026-12-01",
      repeatAfterDays: 14,
      allowedDeviationDays: 0,
      activationResolution: {
        expectedProjects: [{ projectId: 45, revision: 8 }],
        drivers: [{ projectId: 45, ownerMemberId: 9 }],
      },
    });
  });

  it("keeps a concurrent schedule and deadline when retrying a reminder-only edit", async () => {
    const user = userEvent.setup();
    const task = makeTask({
      id: 313,
      revision: 3,
      scheduledDate: "2026-10-15",
      dueDate: "2026-10-22",
      reminders: [],
    });
    const latest = {
      ...task,
      revision: 4,
      scheduledDate: "2026-10-16",
      dueDate: "2026-10-23",
    };
    mockedApi.getTask.mockResolvedValue(latest as never);
    mockedApi.updateTask
      .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_write_conflict" }))
      .mockResolvedValueOnce({ ...latest, revision: 5, reminders: [{ id: 88, kind: "absolute", at: "2026-10-13T08:00:00.000Z" }] } as never);
    renderWithProviders(<TaskPlanningSheet task={task} initialTarget="reminders" onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Morgen früh" }));
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.getTask).toHaveBeenCalledWith(task.id));
    expect(screen.getByLabelText("Geplant für")).toHaveValue("16.10.2026");
    expect(screen.getByLabelText("Deadline")).toHaveValue("23.10.2026");

    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(2));
    const retry = mockedApi.updateTask.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(retry).toMatchObject({ expectedRevision: 4, reminders: [{ kind: "absolute", at: expect.any(String) }] });
    expect(retry).not.toHaveProperty("scheduledDate");
    expect(retry).not.toHaveProperty("dueDate");
    expect(retry).not.toHaveProperty("revisitAt");
  });

  it("keeps concurrently changed reminders when retrying a recurrence-only edit", async () => {
    const user = userEvent.setup();
    const task = makeTask({
      id: 314,
      revision: 5,
      scheduledDate: "2026-10-15",
      reminders: [],
    });
    const latest = {
      ...task,
      revision: 6,
      reminders: [{ id: 89, kind: "absolute" as const, at: "2026-10-13T08:00:00.000Z" }],
    };
    mockedApi.getTask.mockResolvedValue(latest as never);
    mockedApi.updateTask
      .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_write_conflict" }))
      .mockResolvedValueOnce({ ...latest, revision: 7, repeatAfterDays: 14, allowedDeviationDays: 0, dueDate: "2026-10-15" } as never);
    renderWithProviders(<TaskPlanningSheet task={task} initialTarget="recurrence" onClose={vi.fn()} />);

    await user.click(within(card("Geplant für")).getByRole("checkbox", { name: "Wiederholung" }));
    const interval = within(card("Geplant für")).getByLabelText("Wiederholen nach Tagen");
    await user.clear(interval);
    await user.type(interval, "14");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.getTask).toHaveBeenCalledWith(task.id));
    expect(within(card("Erinnerungen")).getByRole("button", { name: "Morgen früh · 08:00" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(2));
    const retry = mockedApi.updateTask.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(retry).toMatchObject({ expectedRevision: 6, repeatAfterDays: 14, allowedDeviationDays: 0 });
    expect(retry).not.toHaveProperty("reminders");
  });

  it("requires an explicit choice before retrying a concurrently edited planning field", async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 315, revision: 1, scheduledDate: "2026-10-15" });
    const latest = { ...task, revision: 2, scheduledDate: "2026-10-17" };
    mockedApi.getTask.mockResolvedValue(latest as never);
    mockedApi.updateTask
      .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_write_conflict" }))
      .mockResolvedValueOnce({ ...latest, revision: 3, scheduledDate: "2026-10-16" } as never);
    renderWithProviders(<TaskPlanningSheet task={task} onClose={vi.fn()} />);

    const plannedDate = screen.getByLabelText("Geplant für");
    fireEvent.change(plannedDate, { target: { value: "16.10.2026" } });
    fireEvent.blur(plannedDate);
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.getTask).toHaveBeenCalledWith(task.id));
    expect(screen.getByText("Aktuell gespeichert:")).toBeInTheDocument();
    expect(screen.getByText("Dein Entwurf:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Meine Änderung beibehalten" }));
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.updateTask.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 2,
      scheduledDate: "2026-10-16",
    });
  });

  it("commits an open custom reminder with the outer planning save", async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 316, scheduledDate: "2026-10-15" });
    mockedApi.updateTask.mockResolvedValue({ ...task, reminders: [{ id: 90, kind: "absolute", at: "2026-10-20T17:00:00.000Z" }] } as never);
    renderWithProviders(<TaskPlanningSheet task={task} initialTarget="reminders" onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Benutzerdefiniert …" }));
    const reminderDate = screen.getByLabelText("Fällig");
    await user.clear(reminderDate);
    await user.type(reminderDate, "20.10.2026");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(1));
    const patch = mockedApi.updateTask.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.reminders).toEqual([{ kind: "absolute", at: expect.any(String) }]);
    expect(new Date((patch.reminders as Array<{ at: string }>)[0]!.at).toISOString()).toContain("2026-10-20");
  });

  it("commits an edited existing custom reminder with the outer save and preserves its identity", async () => {
    const user = userEvent.setup();
    const task = makeTask({
      id: 317,
      scheduledDate: "2026-10-15",
      reminders: [{ id: 91, kind: "deadline_relative", daysBefore: 2, time: "09:00", timezone: "Europe/Berlin" }],
    });
    mockedApi.updateTask.mockResolvedValue({ ...task } as never);
    renderWithProviders(<TaskPlanningSheet task={task} initialTarget="reminders" onClose={vi.fn()} />);

    await user.click(within(card("Erinnerungen")).getByRole("button", { name: /2 Tage vorher/ }));
    const days = screen.getByLabelText("Tage vorher");
    await user.clear(days);
    await user.type(days, "4");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(1));
    expect(mockedApi.updateTask.mock.calls[0]?.[1]).toMatchObject({
      reminders: [{ id: 91, kind: "deadline_relative", daysBefore: 4 }],
    });
  });

  it("blocks an invalid open custom reminder date and keeps the editor draft visible", async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 318, scheduledDate: "2026-10-15" });
    renderWithProviders(<TaskPlanningSheet task={task} initialTarget="reminders" onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Benutzerdefiniert …" }));
    const reminderDate = screen.getByLabelText("Fällig");
    await user.clear(reminderDate);
    await user.type(reminderDate, "kein Datum");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await within(card("Erinnerungen")).findByText("Datum nicht erkannt")).toBeInTheDocument();
    expect(reminderDate).toHaveValue("kein Datum");
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("cancels an open custom reminder without writing any planning changes", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TaskPlanningSheet task={makeTask({ id: 319, scheduledDate: "2026-10-15" })} initialTarget="reminders" onClose={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Benutzerdefiniert …" }));
    await user.type(screen.getByLabelText("Fällig"), "20.10.2026");
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });
});
