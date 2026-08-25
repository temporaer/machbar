import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { api } from "../lib/api";
import { makeMember, makeTag, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    reorderTask: vi.fn(),
    indentTask: vi.fn(),
    outdentTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);
const STORAGE_KEY = "machbar:primary-swipe-action";

/** Simulates a horizontal drag past the swipe threshold and releases it. */
function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".task-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

describe("TaskRow – primary swipe direction mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
    mockedApi.completeTask.mockResolvedValue(makeTask());
    mockedApi.cancelTask.mockResolvedValue(makeTask());
    mockedApi.reopenTask.mockResolvedValue(makeTask());
    mockedApi.updateTask.mockResolvedValue(makeTask());
  });

  it("swipes right into the default configured action (erledigen) for an open task", async () => {
    const task = makeTask({ id: 1, title: "Rechnung bezahlen", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Rechnung bezahlen");

    swipe(container, 100);

    await waitFor(() => expect(mockedApi.completeTask).toHaveBeenCalledWith(1, "leave_open"));
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("can swipe the retained crossed-out row again to reopen it", async () => {
    const task = makeTask({ id: 9, title: "Status direkt wechseln", status: "actionable" });
    const completed = makeTask({ ...task, status: "done" });
    mockedApi.completeTask.mockResolvedValue(completed);
    mockedApi.reopenTask.mockResolvedValue(task);
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );
    await screen.findByText("Status direkt wechseln");

    swipe(container, 100);
    await waitFor(() =>
      expect(mockedApi.completeTask).toHaveBeenCalledWith(9, "leave_open"),
    );
    expect(container.querySelector(".task-row-content.retained")).toBeInTheDocument();

    swipe(container, 100);
    await waitFor(() => expect(mockedApi.reopenTask).toHaveBeenCalledWith(9));
  });

  it("respects a configured 'Warten' primary swipe action on an open task", async () => {
    window.localStorage.setItem(STORAGE_KEY, "waiting");
    const task = makeTask({ id: 2, title: "Antwort abwarten", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Antwort abwarten");

    swipe(container, 100);

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(2, { status: "waiting" }));
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
  });

  it("respects a configured 'Irgendwann' primary swipe action on an open task", async () => {
    window.localStorage.setItem(STORAGE_KEY, "someday");
    const task = makeTask({ id: 3, title: "Bücher sortieren", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Bücher sortieren");

    swipe(container, 100);

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(3, { status: "someday" }));
  });

  it("respects a configured 'Verwerfen' primary swipe action on an open task", async () => {
    window.localStorage.setItem(STORAGE_KEY, "cancel");
    const task = makeTask({ id: 4, title: "Altes Angebot", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Altes Angebot");

    swipe(container, 100);

    await waitFor(() => expect(mockedApi.cancelTask).toHaveBeenCalledWith(4, "leave_open"));
  });

  it.each(["waiting", "someday", "cancel", "complete"] as const)(
    "always reopens an already done task via the primary swipe, regardless of the '%s' setting",
    async (configured) => {
      window.localStorage.setItem(STORAGE_KEY, configured);
      const task = makeTask({ id: 5, title: "Erledigte Aufgabe", status: "done" });
      const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
      await screen.findByText("Erledigte Aufgabe");

      swipe(container, 100);

      await waitFor(() => expect(mockedApi.reopenTask).toHaveBeenCalledWith(5));
      expect(mockedApi.updateTask).not.toHaveBeenCalled();
      expect(mockedApi.cancelTask).not.toHaveBeenCalled();
    },
  );

  it("always reopens an already cancelled task via the primary swipe", async () => {
    window.localStorage.setItem(STORAGE_KEY, "waiting");
    const task = makeTask({ id: 6, title: "Verworfene Aufgabe", status: "cancelled" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Verworfene Aufgabe");

    swipe(container, 100);

    await waitFor(() => expect(mockedApi.reopenTask).toHaveBeenCalledWith(6));
  });

  it("reveals the touch-chip row (not an action) on the opposite swipe direction", async () => {
    const task = makeTask({ id: 7, title: "Projektplan", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Projektplan");

    swipe(container, -100);

    expect(screen.getByRole("button", { name: "Zuweisen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Planen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notizen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wartet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mehr" })).toBeInTheDocument();
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(mockedApi.cancelTask).not.toHaveBeenCalled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("also reveals the chip row via the explicit ⋯ button (non-gesture access)", async () => {
    const task = makeTask({ id: 8, title: "Steuerunterlagen", status: "actionable" });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Steuerunterlagen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));

    expect(screen.getByRole("button", { name: "Zuweisen" })).toBeInTheDocument();
  });

  it("renders task actions as compact SVG buttons rather than visible text", async () => {
    const task = makeTask({ id: 10, title: "Kompakte Aktionen", status: "actionable", projectId: 2 });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Kompakte Aktionen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));

    for (const name of ["Zuweisen", "Planen", "Notizen", "Teilaufgabe hinzufügen", "Zum Projekt", "Wartet", "Mehr"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass("task-row-chip-icon");
      expect(button.textContent).toBe("");
      const glyph = button.querySelector("svg");
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      expect(glyph).toHaveAttribute("focusable", "false");
    }
  });
});

describe("TaskRow – action chips use focused quick-edit flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getTags.mockResolvedValue([makeTag({ id: 20 })]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
  });

  function renderOutlineWithDetail(task: ReturnType<typeof makeTask>) {
    mockedApi.getTask.mockResolvedValue(task);
    return renderWithProviders(
      <div>
        <TaskOutline tasks={[task]} emptyMessage="Nichts da" />
        <TaskDetailSheet />
      </div>,
    );
  }

  it("assigns from a focused sheet and returns without opening full details", async () => {
    const task = makeTask({ id: 30, title: "Kunde anrufen", status: "actionable" });
    renderOutlineWithDetail(task);
    await screen.findByText("Kunde anrufen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Zuweisen" }));

    const group = await screen.findByRole("group", { name: "Zuständig" });
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    // Tap chips rather than a native <select>, with the shared/unassigned
    // bucket offered explicitly and pressed while nobody is assigned.
    expect(within(group).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Gemeinsam / offen" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(within(group).getByRole("button", { name: "Mira" }));
    expect(within(group).getByRole("button", { name: "Mira" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(30, {
        ownerMemberId: 1,
        ownerInheritanceMode: "explicit",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("schedules from a focused sheet", async () => {
    const task = makeTask({ id: 31, title: "Termin vereinbaren", status: "actionable" });
    renderOutlineWithDetail(task);
    await screen.findByText("Termin vereinbaren");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Planen" }));

    const scheduled = await screen.findByLabelText("Geplant");
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    await userEvent.type(scheduled, "2026-09-03");
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(31, {
        scheduledDate: "2026-09-03",
      }),
    );
  });

  it("edits notes from a focused sheet", async () => {
    const task = makeTask({ id: 32, title: "Vertrag prüfen", status: "actionable" });
    renderOutlineWithDetail(task);
    await screen.findByText("Vertrag prüfen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Notizen" }));

    const notes = await screen.findByLabelText("Notizen");
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    await userEvent.type(notes, "Rückfrage vorbereiten");
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(32, {
        notes: "Rückfrage vorbereiten",
      }),
    );
  });

  it("opens the full task detail sheet from the 'Mehr' chip", async () => {
    const task = makeTask({ id: 33, title: "Umzug planen", status: "actionable" });
    renderOutlineWithDetail(task);
    await screen.findByText("Umzug planen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Mehr" }));

    expect(await screen.findByDisplayValue("Umzug planen")).toBeInTheDocument();
  });

  it("sets the task to 'waiting' directly from the 'Warten' chip, without opening the sheet", async () => {
    const task = makeTask({ id: 34, title: "Lieferung abwarten", status: "actionable" });
    renderOutlineWithDetail(task);
    await screen.findByText("Lieferung abwarten");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Wartet" }));

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(34, { status: "waiting" }));
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
  });
});
