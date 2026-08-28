import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import {
  TaskDetailProvider,
  useTaskDetail,
  type TaskDetailFocusField,
} from "../lib/taskDetailContext";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { api } from "../lib/api";
import { makeMember, makeTag, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    getTaskRecurrenceHistory: vi.fn(),
    updateTask: vi.fn(),
    transitionTaskStatus: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    deleteTask: vi.fn(),
    searchTasks: vi.fn(),
    getActivity: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function OpenerHarness({
  taskId,
  focusField,
  children,
}: {
  taskId: number;
  focusField?: TaskDetailFocusField | undefined;
  children: ReactNode;
}) {
  const { open } = useTaskDetail();
  return (
    <div>
      <button type="button" onClick={() => open(taskId, focusField)}>
        open
      </button>
      {children}
    </div>
  );
}

function QueueOpenerHarness({ taskIds, children }: { taskIds: number[]; children: ReactNode }) {
  const { openQueue } = useTaskDetail();
  return (
    <div>
      <button type="button" onClick={() => openQueue(taskIds)}>
        open queue
      </button>
      {children}
    </div>
  );
}

function renderSheet(taskId: number, focusField?: TaskDetailFocusField) {
  return render(
    <MemoryRouter>
      <IdentityProvider>
        <RefreshProvider>
          <TaskDetailProvider>
            <OpenerHarness taskId={taskId} focusField={focusField}>
              <TaskDetailSheet />
            </OpenerHarness>
          </TaskDetailProvider>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>,
  );
}

function renderQueueSheet(taskIds: number[]) {
  return render(
    <MemoryRouter>
      <IdentityProvider>
        <RefreshProvider>
          <TaskDetailProvider>
            <QueueOpenerHarness taskIds={taskIds}>
              <TaskDetailSheet />
            </QueueOpenerHarness>
          </TaskDetailProvider>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>,
  );
}

async function openNotesEditor(): Promise<HTMLTextAreaElement> {
  const editButton = screen.getByRole("button", { name: "Bearbeiten" });
  expect(editButton).toHaveClass("icon-action-button");
  expect(editButton).toHaveAttribute("title", "Bearbeiten");
  expect(editButton).not.toHaveTextContent("Bearbeiten");
  await userEvent.click(editButton);
  return screen.getByLabelText("Notizen") as HTMLTextAreaElement;
}

describe("TaskDetailSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getTags.mockResolvedValue([makeTag({ id: 10, name: "büro" })]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
    mockedApi.transitionTaskStatus.mockResolvedValue(makeTask());
    mockedApi.getActivity.mockResolvedValue({ items: [], nextCursor: null });
    mockedApi.getTaskRecurrenceHistory.mockResolvedValue({
      summary: { hitCount: 0, missCount: 0, totalCount: 0, hitRate: null },
      occurrences: [],
    });
  });

  it("loads task activity only after its collapsed disclosure is opened", async () => {
    mockedApi.getTask.mockResolvedValue(makeTask({ id: 42, title: "Reparaturziel" }));
    renderSheet(42);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await screen.findByDisplayValue("Reparaturziel");

    expect(mockedApi.getActivity).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Letzte Aktivitäten"));
    await waitFor(() =>
      expect(mockedApi.getActivity).toHaveBeenCalledWith({ taskId: 42, limit: 5 }),
    );
  });

  it("focuses the requested title repair field", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 42, title: "Reparaturziel", dependencies: [], children: [] }),
    );
    renderSheet(42, "title");

    await userEvent.click(screen.getByRole("button", { name: "open" }));

    await waitFor(() => expect(screen.getByLabelText("Titel")).toHaveFocus());
  });

  it("focuses dependency search after unresolved dependency removal controls", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({
        id: 42,
        title: "Reparaturziel",
        dependencies: [
          {
            id: 71,
            taskId: 42,
            dependsOnTaskId: 19,
            title: "Freigabe einholen",
            resolved: false,
          },
        ],
      }),
    );
    renderSheet(42, "dependencies");

    await userEvent.click(screen.getByRole("button", { name: "open" }));

    const searchInput = await screen.findByLabelText("Aufgabe suchen …");
    const removeButton = screen.getByRole("button", { name: "Entfernen" });
    await waitFor(() => expect(searchInput).toHaveFocus());
    expect(removeButton).not.toHaveFocus();
  });

  it("focuses the add-child input after closed child reopen controls", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({
        id: 42,
        title: "Reparaturziel",
        children: [
          makeTask({ id: 43, parentTaskId: 42, title: "Erledigte Teilaufgabe", status: "done" }),
          makeTask({ id: 44, parentTaskId: 42, title: "Verworfene Teilaufgabe", status: "cancelled" }),
        ],
      }),
    );
    renderSheet(42, "subtasks");

    await userEvent.click(screen.getByRole("button", { name: "open" }));

    const addChildInput = await screen.findByLabelText("Teilaufgabe hinzufügen");
    const reopenButtons = screen.getAllByRole("button", { name: "Wieder öffnen" });
    await waitFor(() => expect(addChildInput).toHaveFocus());
    for (const reopenButton of reopenButtons) {
      expect(reopenButton).not.toHaveFocus();
    }
  });

  it("zeigt geerbte Tags mit Ausschluss-Option und erlaubt das Umschalten des Zuständigkeits-Vererbungsmodus", async () => {
    const inheritedTag = makeTag({ id: 11, name: "eilig" });
    const task = makeTask({
      id: 42,
      title: "Bericht schreiben",
      ownerInheritanceMode: "inherit",
      effectiveTags: [inheritedTag],
      explicitTags: [],
      excludedTagIds: [],
    });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(42);
    await userEvent.click(screen.getByText("open"));

    expect(await screen.findByDisplayValue("Bericht schreiben")).toBeInTheDocument();
    expect(screen.getByText("eilig")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Übergeordnet" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Aufgabenspezifisch" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Keine" })).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: "Aufgabenspezifisch" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(42, {
      ownerInheritanceMode: "explicit",
      expectedRevision: 1,
    }));
  });

  it("wählt eine aufgabenspezifische Zuständigkeit direkt per Chip und behält die API-Patches bei", async () => {
    const task = makeTask({
      id: 57,
      title: "Verantwortung klären",
      ownerInheritanceMode: "explicit",
      ownerMemberId: 1,
    });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(57);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Verantwortung klären");

    const ownerChoices = screen.getByRole("group", { name: "Zuständig" });
    expect(within(ownerChoices).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(ownerChoices).getByRole("button", { name: "Mira" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(ownerChoices).getByRole("button", { name: "Niemand zugewiesen" })).toBeInTheDocument();

    await userEvent.click(within(ownerChoices).getByRole("button", { name: "Niemand zugewiesen" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(57, {
      ownerMemberId: null,
      expectedRevision: 1,
    }));
  });

  it("zeigt keinen manuellen Heute-Umschalter/-Haken mehr an", async () => {
    const task = makeTask({ id: 44, title: "Keller aufräumen" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(44);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Keller aufräumen");

    expect(screen.queryByText("Heute erledigen")).not.toBeInTheDocument();
    expect(screen.queryByText("Für heute markieren")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Für heute markieren" }),
    ).not.toBeInTheDocument();
  });

  it("places sharing in the header and uses only the status select for general status changes", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 45, title: "Unaufdringliche Details", status: "actionable" }),
    );
    renderSheet(45);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Unaufdringliche Details");

    const heading = screen.getByRole("heading", { name: "Details" });
    const header = heading.closest<HTMLElement>(".sheet-header");
    expect(header).not.toBeNull();
    expect(within(header!).getByRole("button", { name: "Teilen" })).toBeInTheDocument();
    expect(within(header!).getByRole("button", { name: "Schließen" })).toHaveClass(
      "icon-action-button",
    );
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Erledigt" })).not.toBeInTheDocument();
  });

  it("routes terminal status selections through lifecycle mutations", async () => {
    const task = makeTask({
      id: 46,
      title: "Status korrekt ändern",
      status: "actionable",
      children: [],
    });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.completeTask.mockResolvedValue({ ...task, status: "done" });
    renderSheet(46);
    await userEvent.click(screen.getByText("open"));
    const status = await screen.findByLabelText("Status");

    await userEvent.selectOptions(status, "done");
    await waitFor(() =>
      expect(mockedApi.completeTask).toHaveBeenCalledWith(46, "leave_open"),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalledWith(
      46,
      expect.objectContaining({ status: "done" }),
    );
  });

  it("applies a terminal-to-non-terminal status atomically", async () => {
    const task = makeTask({
      id: 47,
      title: "Wieder warten",
      status: "done",
      completedAt: "2026-08-27T10:00:00.000Z",
    });
    mockedApi.getTask.mockResolvedValue(task);
    renderSheet(47);
    await userEvent.click(screen.getByText("open"));

    await userEvent.selectOptions(await screen.findByLabelText("Status"), "waiting");

    await waitFor(() =>
      expect(mockedApi.transitionTaskStatus).toHaveBeenCalledWith(47, "waiting"),
    );
    expect(mockedApi.reopenTask).not.toHaveBeenCalled();
  });

  it("applies a terminal-to-terminal status atomically", async () => {
    const task = makeTask({
      id: 48,
      title: "Doch erledigt",
      status: "cancelled",
      cancelledAt: "2026-08-27T10:00:00.000Z",
    });
    mockedApi.getTask.mockResolvedValue(task);
    renderSheet(48);
    await userEvent.click(screen.getByText("open"));

    await userEvent.selectOptions(await screen.findByLabelText("Status"), "done");

    await waitFor(() =>
      expect(mockedApi.transitionTaskStatus).toHaveBeenCalledWith(48, "done"),
    );
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(mockedApi.reopenTask).not.toHaveBeenCalled();
  });

  it("shows and locks an in-flight direct status transition", async () => {
    let resolveTransition!: (task: ReturnType<typeof makeTask>) => void;
    const transition = new Promise<ReturnType<typeof makeTask>>((resolve) => {
      resolveTransition = resolve;
    });
    const task = makeTask({
      id: 49,
      title: "Status bleibt stabil",
      status: "done",
      completedAt: "2026-08-27T10:00:00.000Z",
    });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.transitionTaskStatus.mockReturnValue(transition);
    renderSheet(49);
    await userEvent.click(screen.getByText("open"));
    const status = await screen.findByLabelText("Status");

    await userEvent.selectOptions(status, "waiting");

    expect(status).toHaveValue("waiting");
    expect(status).toBeDisabled();
    resolveTransition({ ...task, status: "waiting", completedAt: null });
    await waitFor(() => expect(status).not.toBeDisabled());
  });

  it("bietet dieselben Schnelloptionen und kann eine Planung entfernen", async () => {
    const task = makeTask({ id: 56, title: "Wochenplanung", scheduledDate: "2026-09-04" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(56);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Wochenplanung");

    const shortcuts = screen.getByRole("group", { name: "Schnell planen" });
    await userEvent.click(within(shortcuts).getByRole("button", { name: "Nicht geplant" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(56, {
        scheduledDate: null,
        expectedRevision: 1,
      }),
    );
  });

  it("accepts human-readable scheduling dates and patches ISO values", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 58, title: "Termin planen", scheduledDate: null }),
    );
    renderSheet(58);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Termin planen");

    const scheduledDate = screen.getByLabelText("Geplant");
    fireEvent.change(scheduledDate, { target: { value: "12. September 2026" } });
    fireEvent.blur(scheduledDate);

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(58, {
        scheduledDate: "2026-09-12",
        expectedRevision: 1,
      }),
    );
    expect(scheduledDate).toHaveValue("12.09.2026");
  });

  it("uses the same natural-language editor for the due date", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 59, title: "Fälligkeit planen", dueDate: null }),
    );
    renderSheet(59);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Fälligkeit planen");

    const dueDate = screen.getByLabelText("Fällig");
    expect(dueDate).toHaveAttribute("type", "text");
    expect(dueDate).toHaveAttribute(
      "placeholder",
      "z. B. morgen, Freitag, KW 36, 2w",
    );
    fireEvent.change(dueDate, { target: { value: "13. September 2026" } });
    fireEvent.blur(dueDate);

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(59, {
        dueDate: "2026-09-13",
        expectedRevision: 1,
      }),
    );
    expect(dueDate).toHaveValue("13.09.2026");
  });

  it("edits recurrence, locks the derived deadline, and retains dates on disable", async () => {
    const task = makeTask({
      id: 61,
      title: "Filter wechseln",
      scheduledDate: "2026-09-10",
      dueDate: "2026-09-12",
      repeatAfterDays: 7,
      allowedDeviationDays: 2,
    });
    mockedApi.getTask.mockResolvedValue(task);
    renderSheet(61);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Filter wechseln");

    expect(screen.getByLabelText("Fällig")).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Aktiv" }),
    ).toBeChecked();
    expect(screen.getByLabelText("Wiederholen nach Tagen")).toHaveValue(7);
    expect(
      screen.getByLabelText("Erlaubte Abweichung in Tagen"),
    ).toHaveValue(2);
    expect(
      screen.getByText("Aktuelle inklusive Frist: 12.09.2026"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Aktiv" }));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(61, {
        repeatAfterDays: null,
        allowedDeviationDays: null,
        expectedRevision: 1,
      }),
    );
  });

  it("shows empty and populated recurrence history", async () => {
    const task = makeTask({
      id: 62,
      title: "Pflanzen gießen",
      scheduledDate: "2026-09-10",
      dueDate: "2026-09-11",
      repeatAfterDays: 3,
      allowedDeviationDays: 1,
    });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.getTaskRecurrenceHistory.mockResolvedValue({
      summary: { hitCount: 1, missCount: 1, totalCount: 2, hitRate: 0.5 },
      occurrences: [
        {
          id: 2,
          taskId: 62,
          scheduledDate: "2026-09-07",
          deadlineDate: "2026-09-08",
          completedOn: "2026-09-09",
          completedAt: "2026-09-09T08:00:00.000Z",
          result: "miss",
        },
        {
          id: 1,
          taskId: 62,
          scheduledDate: "2026-09-03",
          deadlineDate: "2026-09-04",
          completedOn: "2026-09-03",
          completedAt: "2026-09-03T08:00:00.000Z",
          result: "hit",
        },
      ],
    });
    renderSheet(62);
    await userEvent.click(screen.getByText("open"));

    expect(
      await screen.findByText(/50\s*%\s*Trefferquote/),
    ).toBeInTheDocument();
    expect(screen.getByText("+1 Treffer")).toBeInTheDocument();
    expect(screen.getByText("−1 Verpasst")).toBeInTheDocument();
    expect(screen.getAllByText("Verpasst")).not.toHaveLength(0);
    expect(screen.getAllByText("Treffer")).not.toHaveLength(0);
  });

  it("schließt einen ausgeschlossenen geerbten Tag über den Umschalter aus", async () => {
    const inheritedTag = makeTag({ id: 11, name: "eilig" });
    const task = makeTask({
      id: 43,
      title: "Angebot prüfen",
      effectiveTags: [inheritedTag],
      explicitTags: [],
      excludedTagIds: [],
    });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(43);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Angebot prüfen");

    await userEvent.click(screen.getByRole("button", { name: "Ausschließen" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(43, {
      excludedTagIds: [11],
      expectedRevision: 1,
    }));
  });

  it("aktiviert Änderungen speichern erst, nachdem die Notizen bearbeitet wurden", async () => {
    const task = makeTask({ id: 45, title: "Wäsche waschen", notes: "" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(45);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Wäsche waschen");

    const saveButton = screen.getByRole("button", { name: "Änderungen speichern" });
    expect(saveButton).toBeDisabled();

    const notesField = await openNotesEditor();
    await userEvent.type(notesField, "Feinwäsche zuerst");

    expect(saveButton).toBeEnabled();
  });

  it("speichert bearbeitete Notizen vor dem Schließen des Detailblatts", async () => {
    const task = makeTask({ id: 58, title: "Ausflug planen", notes: "Alt" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(58);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Ausflug planen");

    const notesField = await openNotesEditor();
    await userEvent.clear(notesField);
    await userEvent.type(notesField, "Neue Notiz");
    await userEvent.click(screen.getByRole("button", { name: "Schließen" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(58, {
        title: "Ausflug planen",
        notes: "Neue Notiz",
        waitingFor: null,
        expectedRevision: 1,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Aufgabe bearbeiten" })).not.toBeInTheDocument(),
    );
  });

  it("aktiviert Änderungen speichern nach Bearbeitung von Titel/Metadaten und sendet den Request beim Klick", async () => {
    const task = makeTask({ id: 46, title: "Einkaufen", notes: "Milch" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(46);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Einkaufen");

    const saveButton = screen.getByRole("button", { name: "Änderungen speichern" });
    expect(saveButton).toBeDisabled();

    const titleField = screen.getByLabelText("Titel") as HTMLInputElement;
    await userEvent.clear(titleField);
    await userEvent.type(titleField, "Einkaufen gehen");

    expect(saveButton).toBeEnabled();

    await userEvent.click(saveButton);

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(46, {
        title: "Einkaufen gehen",
        notes: "Milch",
        waitingFor: null,
        expectedRevision: 1,
      }),
    );
  });

  it("lädt bei einem Versionskonflikt neu und behält den lokalen Entwurf", async () => {
    const original = makeTask({
      id: 60,
      revision: 1,
      title: "Gemeinsame Aufgabe",
      notes: "Alt",
    });
    const remote = makeTask({
      ...original,
      revision: 2,
      title: "Remote umbenannt",
      notes: "Auf anderem Gerät geändert",
    });
    mockedApi.getTask.mockResolvedValueOnce(original).mockResolvedValue(remote);
    mockedApi.updateTask
      .mockRejectedValueOnce(
        Object.assign(new Error("stale"), {
          name: "ApiError",
          code: "stale_write_conflict",
        }),
      )
      .mockResolvedValue(
        makeTask({
          ...remote,
          revision: 3,
          notes: "Mein lokaler Entwurf",
        }),
      );

    renderSheet(60);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Gemeinsame Aufgabe");
    const notesField = await openNotesEditor();
    await userEvent.clear(notesField);
    await userEvent.type(notesField, "Mein lokaler Entwurf");
    await userEvent.click(
      screen.getByRole("button", { name: "Änderungen speichern" }),
    );

    await screen.findByText(
      "Dieser Eintrag wurde auf einem anderen Gerät geändert. Die neueste Version wurde geladen und dein Entwurf beibehalten.",
    );
    await waitFor(() => expect(mockedApi.getTask.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByLabelText("Titel")).toHaveValue("Remote umbenannt");
    expect(screen.getByLabelText("Notizen")).toHaveValue("Mein lokaler Entwurf");

    await userEvent.click(
      screen.getByRole("button", { name: "Änderungen speichern" }),
    );
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenLastCalledWith(60, {
        title: "Remote umbenannt",
        notes: "Mein lokaler Entwurf",
        waitingFor: null,
        expectedRevision: 2,
      }),
    );
  });

  it("deaktiviert Änderungen speichern wieder, sobald alle Felder auf den Ursprungszustand zurückgesetzt werden", async () => {
    const task = makeTask({ id: 47, title: "Rechnung prüfen", notes: "" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(47);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Rechnung prüfen");

    const saveButton = screen.getByRole("button", { name: "Änderungen speichern" });
    const notesField = await openNotesEditor();

    await userEvent.type(notesField, "Beleg suchen");
    expect(saveButton).toBeEnabled();

    await userEvent.clear(notesField);
    expect(saveButton).toBeDisabled();
  });

  it("deaktiviert Änderungen speichern bei leerem Titel, auch wenn andere Felder geändert wurden", async () => {
    const task = makeTask({ id: 48, title: "Termin vereinbaren", notes: "" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(48);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Termin vereinbaren");

    const saveButton = screen.getByRole("button", { name: "Änderungen speichern" });
    const notesField = await openNotesEditor();
    const titleField = screen.getByLabelText("Titel") as HTMLInputElement;

    // Clear the title first, then move focus into notes (blurring the now-
    // invalid title) before typing, so the only blur-triggered auto-save
    // attempt happens while the title is empty.
    await userEvent.clear(titleField);
    await userEvent.type(notesField, "Kalender prüfen");
    expect(saveButton).toBeDisabled();

    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("behält bearbeitete Notizen bei einem Reload durch einen anderen Patch auf derselben Aufgabe", async () => {
    const task = makeTask({ id: 49, title: "Garten pflegen", notes: "alt" });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.updateTask.mockResolvedValue({ ...task, priority: 2 });

    renderSheet(49);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Garten pflegen");

    const notesField = await openNotesEditor();
    await userEvent.type(notesField, " neu");

    // Trigger an unrelated patch (priority change) which reloads this same task.
    await userEvent.selectOptions(screen.getByLabelText("Priorität"), "2");
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(49, {
      priority: 2,
      expectedRevision: 1,
    }));

    // The in-progress notes edit must survive the reload triggered above.
    expect(screen.getByLabelText("Notizen")).toHaveValue("alt neu");
  });

  it("klärt mit Speichern & weiter auch unveränderte Aufgaben und öffnet erst nach Erfolg die nächste", async () => {
    const first = makeTask({ id: 50, title: "Erste Erfassung", needsClarification: true });
    const second = makeTask({ id: 51, title: "Zweite Erfassung", needsClarification: true });
    mockedApi.getTask.mockImplementation(async (id) => (id === 50 ? first : second));

    renderQueueSheet([50, 51]);
    await userEvent.click(screen.getByText("open queue"));
    await screen.findByDisplayValue("Erste Erfassung");

    await userEvent.click(screen.getByRole("button", { name: "Speichern & weiter" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(50, {
        title: "Erste Erfassung",
        notes: "",
        waitingFor: null,
        status: "actionable",
        expectedRevision: 1,
      }),
    );
    expect(await screen.findByDisplayValue("Zweite Erfassung")).toBeInTheDocument();
  });

  it("behält bei einem Fehler die aktuelle Klärungsaufgabe und zeigt den Fehler an", async () => {
    const task = makeTask({ id: 52, title: "Nicht verlieren", needsClarification: true });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.updateTask.mockRejectedValueOnce(new Error("Speichern fehlgeschlagen"));

    renderQueueSheet([52, 53]);
    await userEvent.click(screen.getByText("open queue"));
    await screen.findByDisplayValue("Nicht verlieren");

    await userEvent.click(screen.getByRole("button", { name: "Speichern & weiter" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Speichern fehlgeschlagen");
    expect(screen.getByDisplayValue("Nicht verlieren")).toBeInTheDocument();
    expect(mockedApi.getTask).toHaveBeenCalledWith(52);
    expect(mockedApi.getTask).not.toHaveBeenCalledWith(53);
  });

  it("klärt bei gewöhnlichem Speichern oder Unschärfe nicht automatisch", async () => {
    const task = makeTask({ id: 54, title: "Roh erfasst", notes: "", needsClarification: true });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(54);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Roh erfasst");

    const notesField = await openNotesEditor();
    await userEvent.type(notesField, "Ergänzung");
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalled());
    expect(mockedApi.updateTask).toHaveBeenLastCalledWith(54, {
      title: "Roh erfasst",
      notes: "Ergänzung",
      waitingFor: null,
      expectedRevision: 1,
    });
  });

  it("löscht die Klärungsmarkierung bei einer expliziten Statuswahl", async () => {
    const task = makeTask({ id: 55, title: "Status wählen", needsClarification: true });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(55);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Status wählen");

    await userEvent.selectOptions(screen.getByLabelText("Status"), "waiting");

    await waitFor(() =>
      expect(mockedApi.transitionTaskStatus).toHaveBeenCalledWith(55, "waiting"),
    );
  });
});
