import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskActionsProvider } from "../lib/useTaskActions";
import { ProjectActionsProvider } from "../lib/useProjectActions";
import {
  TaskDetailProvider,
  useTaskDetail,
  type TaskDetailFocusField,
} from "../lib/taskDetailContext";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTag, makeTask } from "../test/fixtures";
import { de as strings } from "../i18n/de";

vi.mock("../lib/api", () => ({
  paperlessDocumentDownloadUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/download`,
  paperlessDocumentPreviewUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/preview`,
  paperlessDocumentThumbnailUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/thumbnail`,
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    getTaskRecurrenceHistory: vi.fn(),
    updateTask: vi.fn(),
    convertTaskToStory: vi.fn(),
    createTask: vi.fn(),
    setExternalWait: vi.fn(),
    addCriterion: vi.fn(),
    updateProject: vi.fn(),
    resolveExternalWait: vi.fn(),
    transitionTaskStatus: vi.fn(),
    clarifyTask: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    deleteTask: vi.fn(),
    searchTasks: vi.fn(),
    addDependency: vi.fn(),
    getActivity: vi.fn(),
    uploadPaperlessDocument: vi.fn(),
    searchPaperlessDocuments: vi.fn(),
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
  return renderWithProviders(
    <OpenerHarness taskId={taskId} focusField={focusField}>
      <TaskDetailSheet />
      <TaskWorkflowHost />
    </OpenerHarness>,
  );
}

function renderQueueSheet(taskIds: number[]) {
  return renderWithProviders(
    <QueueOpenerHarness taskIds={taskIds}>
      <TaskDetailSheet />
      <TaskWorkflowHost />
    </QueueOpenerHarness>,
  );
}

async function openNotesEditor(): Promise<HTMLTextAreaElement> {
  const notesField = screen
    .getByText("Notizen", { selector: "label" })
    .closest<HTMLElement>(".task-notes-field")!;
  const editButton = within(notesField).getByRole("button", {
    name: "Bearbeiten",
  });
  expect(editButton).toHaveClass("icon-action-button");
  expect(editButton).toHaveAttribute("title", "Bearbeiten");
  expect(editButton).not.toHaveTextContent("Bearbeiten");
  await userEvent.click(editButton);
  return within(notesField).getByLabelText("Notizen") as HTMLTextAreaElement;
}

async function openTitleEditor(): Promise<HTMLInputElement> {
  const titleField = screen
    .getByText("Titel", { selector: "label" })
    .closest<HTMLElement>(".field")!;
  await userEvent.click(
    within(titleField).getByRole("button", { name: "Bearbeiten" }),
  );
  return within(titleField).getByLabelText("Titel") as HTMLInputElement;
}

async function waitForTaskTitle(title: string) {
  return screen.findByText(title, { selector: "strong" });
}

describe("TaskDetailSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getTags.mockResolvedValue([makeTag({ id: 10, name: "büro" })]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
    mockedApi.convertTaskToStory.mockResolvedValue(
      makeProject({ id: 80, title: "Projekt aus Erfassung" }),
    );
    mockedApi.createTask.mockResolvedValue(makeTask());
    mockedApi.addCriterion.mockResolvedValue(makeProject());
    mockedApi.updateProject.mockResolvedValue(makeProject());
    mockedApi.setExternalWait.mockResolvedValue(makeTask());
    mockedApi.resolveExternalWait.mockResolvedValue(makeTask());
    mockedApi.transitionTaskStatus.mockResolvedValue(makeTask());
    mockedApi.clarifyTask.mockResolvedValue(makeTask({ status: "actionable" }));
    mockedApi.completeTask.mockResolvedValue(makeTask({ status: "done" }));
    mockedApi.cancelTask.mockResolvedValue(makeTask({ status: "cancelled" }));
    mockedApi.reopenTask.mockResolvedValue(makeTask({ status: "actionable" }));
    mockedApi.addDependency.mockResolvedValue(makeTask());
    mockedApi.getActivity.mockResolvedValue({ items: [], nextCursor: null });
    mockedApi.getTaskRecurrenceHistory.mockResolvedValue({
      summary: { hitCount: 0, missCount: 0, totalCount: 0, hitRate: null },
      occurrences: [],
    });
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 91,
      title: "receipt",
      originalFileName: "receipt.pdf",
      mimeType: "application/pdf",
    });
  });

  it("shows Calendar export beside Share only for a dated Task", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({
        id: 42,
        title: "Elternabend",
        dueDate: "2026-09-15",
      }),
    );
    renderSheet(42);
    await userEvent.click(screen.getByRole("button", { name: "open" }));

    expect(
      await screen.findByRole("button", { name: "Teilen" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "In Kalender" }),
    ).toBeInTheDocument();
  });

  it("does not show Calendar export for a Task without a deadline", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 42, title: "Ohne Termin", dueDate: null }),
    );
    renderSheet(42);
    await userEvent.click(screen.getByRole("button", { name: "open" }));

    expect(
      await screen.findByRole("button", { name: "Teilen" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "In Kalender" }),
    ).not.toBeInTheDocument();
  });

  it("appends a direct attachment through the revision-safe task action", async () => {
    const task = makeTask({ id: 42, title: "Beleg prüfen", notes: "Vorhanden" });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.updateTask.mockResolvedValue({
      ...task,
      notes: "Vorhanden\n\n[receipt.pdf](paperless:91)",
      revision: 2,
    });
    renderSheet(42);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitForTaskTitle("Beleg prüfen");

    await userEvent.click(screen.getByRole("button", { name: "Anhang hinzufügen" }));
    await userEvent.upload(
      screen.getByLabelText("Datei auswählen"),
      new File(["pdf"], "receipt.pdf", { type: "application/pdf" }),
    );

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(42, {
        notes: "Vorhanden\n\n[receipt.pdf](paperless:91)",
        expectedRevision: 1,
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Anhang" })).not.toBeInTheDocument();
  });

  it("inserts a header attachment at the active notes cursor without saving", async () => {
    const task = makeTask({ id: 42, title: "Beleg prüfen", notes: "Vorher Nachher" });
    mockedApi.getTask.mockResolvedValue(task);
    renderSheet(42);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitForTaskTitle("Beleg prüfen");
    const notes = await openNotesEditor();
    notes.setSelectionRange(7, 7);

    await userEvent.click(screen.getByRole("button", { name: "Anhang hinzufügen" }));
    await userEvent.upload(
      screen.getByLabelText("Datei auswählen"),
      new File(["pdf"], "receipt.pdf", { type: "application/pdf" }),
    );

    await waitFor(() =>
      expect(notes).toHaveValue("Vorher [receipt.pdf](paperless:91)Nachher"),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("reads as a document: no scalar-property editors, no empty-state prose", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 42, title: "Strukturierte Aufgabe" }),
    );
    renderSheet(42);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitForTaskTitle("Strukturierte Aufgabe");

    // Authored content and the two real collections stay; every scalar
    // property is a command, not an embedded editor.
    expect(screen.getByText("Titel", { selector: "label" })).toBeVisible();
    expect(screen.getByText("Notizen", { selector: "label" })).toBeVisible();
    for (const heading of ["Teilaufgaben", "Abhängigkeiten"]) {
      expect(
        screen.getByRole("heading", { name: heading, level: 3 }),
      ).toBeVisible();
    }

    for (const label of [
      "Status",
      "Priorität",
      "Fällig",
      "Eingeplant für",
      "Worauf wartet die Aufgabe?",
      "Wiederholen nach Tagen",
    ]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(
      screen.queryByRole("group", { name: "Zuständig" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Schnell planen" }),
    ).not.toBeInTheDocument();

    // The old inspector's empty-state prose is gone with its sections.
    for (const prose of [
      "Keine Termine oder Priorität",
      "Keine Notizen oder Tags",
      "Nicht blockiert",
    ]) {
      expect(screen.queryByText(prose)).not.toBeInTheDocument();
    }

    // Unset rare properties show nothing at all; unset common ones offer a
    // lightweight affordance that dispatches the same command.
    const meta = document.querySelector<HTMLElement>(".detail-meta-row")!;
    expect(
      within(meta).queryByRole("button", { name: /Priorität/ }),
    ).not.toBeInTheDocument();
    expect(
      within(meta).queryByRole("button", { name: /Wiederholung/ }),
    ).not.toBeInTheDocument();
    for (const affordance of ["+ Planen", "+ Warten auf", "+ Zuweisen"]) {
      expect(within(meta).getByRole("button", { name: affordance })).toBeVisible();
    }

    // Created/updated timestamps are always visible near the top, not
    // buried inside the collapsed Organisation disclosure.
    expect(screen.getByText(/Erstellt:/)).toBeVisible();

    const activity = screen
      .getByRole("heading", { name: "Letzte Aktivitäten", level: 2 })
      .closest("details");
    const organization = screen
      .getByRole("heading", { name: "Organisation", level: 3 })
      .closest("details");
    const danger = screen
      .getByRole("heading", { name: "Gefahrenbereich", level: 3 })
      .closest("details");
    expect(activity).not.toHaveAttribute("open");
    expect(organization).not.toHaveAttribute("open");
    expect(danger).not.toHaveAttribute("open");

    await userEvent.click(
      screen.getByRole("heading", { name: "Organisation", level: 3 }),
    );
    expect(screen.getByText("Sortier-Werkzeuge")).toBeVisible();

    await userEvent.click(
      screen.getByRole("heading", { name: "Gefahrenbereich", level: 3 }),
    );
    expect(screen.getByRole("button", { name: "Löschen" })).toBeVisible();
  });

  it("reaches every task command from the detail's own command list", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 42, title: "Vollständige Aufgabe" }),
    );
    renderSheet(42);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitForTaskTitle("Vollständige Aufgabe");

    await userEvent.click(
      screen.getByRole("heading", { name: "Weitere Aktionen", level: 3 }),
    );
    for (const label of [
      "Planen",
      "Warten / Nachhaken",
      "Aufteilen",
      "Zuweisen",
      "Projekt ändern",
      "Folgeaufgabe anlegen",
      "Wiederholung",
      "Priorität",
      "Tags",
      "Kontext",
      "Zum Projekt machen",
      "Verwerfen",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
  });

  it("loads task activity only after its collapsed disclosure is opened", async () => {
    mockedApi.getTask.mockResolvedValue(makeTask({ id: 42, title: "Reparaturziel" }));
    renderSheet(42);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitForTaskTitle("Reparaturziel");

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

  it("surfaces why a searched task cannot be added as a dependency", async () => {
    const task = makeTask({ id: 42, title: "Reparaturziel" });
    const candidate = makeTask({ id: 19, title: "Freigabe einholen" });
    const cycleError = Object.assign(
      new Error("This dependency would create a cycle."),
      {
        name: "ApiError",
        code: "task_dependency_cycle" as const,
      },
    );
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.searchTasks.mockResolvedValue([candidate]);
    mockedApi.addDependency.mockRejectedValue(cycleError);
    renderSheet(42);

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await userEvent.click(
      screen.getByRole("heading", { name: "Abhängigkeiten", level: 3 }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Abhängigkeit hinzufügen" }),
    );
    await userEvent.type(
      await screen.findByLabelText("Aufgabe suchen …"),
      "Freigabe",
    );
    const result = await screen.findByRole("button", {
      name: "Abhängigkeit hinzufügen: Freigabe einholen",
    });
    await userEvent.click(result);

    expect(
      await screen.findByText(
        "„Freigabe einholen“ hängt bereits direkt oder indirekt von „Reparaturziel“ ab. Die umgekehrte Abhängigkeit würde einen Kreis erzeugen.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "„Freigabe einholen“ hängt bereits direkt oder indirekt von „Reparaturziel“ ab. Die umgekehrte Abhängigkeit würde einen Kreis erzeugen.",
      ).closest("li"),
    ).toContainElement(result);
    expect(result).toBeInTheDocument();
  });

  it("ranks dependency matches before limiting and shows their project context", async () => {
    const existing = makeTask({ id: 18, title: "Schon verknüpft" });
    const task = makeTask({
      id: 42,
      title: "Reparaturziel",
      projectId: 5,
      dependencies: [
        {
          id: 71,
          taskId: 42,
          dependsOnTaskId: existing.id,
          title: existing.title,
          resolved: false,
        },
      ],
    });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.searchTasks.mockResolvedValue([
      task,
      existing,
      makeTask({
        id: 1,
        title: "Freigabe",
        projectId: 9,
        projectTitle: "Bad",
        status: "done",
      }),
      makeTask({
        id: 2,
        title: "Freigabe",
        projectId: 5,
        projectTitle: "Küche",
      }),
      makeTask({
        id: 3,
        title: "Bau Freigabe",
        projectId: 5,
        projectTitle: "Küche",
      }),
      makeTask({
        id: 4,
        title: "Notiz",
        notes: "Freigabe",
        projectId: 5,
        projectTitle: "Küche",
      }),
    ]);
    renderSheet(42);

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Abhängigkeit hinzufügen" }),
    );
    await userEvent.type(
      await screen.findByLabelText("Aufgabe suchen …"),
      "Freigabe",
    );

    const results = await screen.findAllByRole("button", {
      name: /^Abhängigkeit hinzufügen:/,
    });
    expect(results.map((result) => result.textContent)).toEqual([
      "Abhängigkeit hinzufügen: Freigabe · Küche",
      "Abhängigkeit hinzufügen: Freigabe · Bad",
      "Abhängigkeit hinzufügen: Bau Freigabe · Küche",
      "Abhängigkeit hinzufügen: Notiz · Küche",
    ]);
  });

  it("shows an existing external wait as a value that opens the follow-up workflow", async () => {
    const task = makeTask({
      id: 42,
      title: "Freigabe",
      externalWait: {
        waitingFor: "Vermieter",
        revisitDate: "2026-09-05",
      },
      blocked: true,
      executable: false,
      scheduledDate: "2026-09-10",
      nextBlockerAttentionDate: "2026-09-05",
    });
    mockedApi.getTask.mockResolvedValue(task);
    renderSheet(42);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitForTaskTitle("Freigabe");

    // Waiting is blocker data, never a status.
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
    const waitValue = screen.getByRole("button", {
      name: /Wartet auf.*Vermieter.*05\.09\.2026/,
    });

    await userEvent.click(waitValue);

    // An already-waiting task resolves to Nachhaken, not "mark as waiting".
    expect(
      await screen.findByRole("heading", { name: "Nachhaken: Freigabe" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Worauf wartest du?"),
    ).not.toBeInTheDocument();
  });

  it("offers waiting as a lightweight affordance that opens the wait workflow", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 43, title: "Rechnung prüfen" }),
    );
    renderSheet(43);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitForTaskTitle("Rechnung prüfen");

    await userEvent.click(screen.getByRole("button", { name: "+ Warten auf" }));

    // A task with no external wait resolves to the "start waiting" workflow,
    // whose commit stays disabled until a reason is given.
    expect(await screen.findByLabelText("Worauf wartest du?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Warten" })).toBeDisabled();
    expect(mockedApi.setExternalWait).not.toHaveBeenCalled();
  });

  it("opens the split workflow from the Teilaufgaben section's Aufteilen button", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({
        id: 42,
        title: "Reparaturziel",
        children: [
          makeTask({ id: 43, parentTaskId: 42, title: "Erledigte Teilaufgabe", status: "done" }),
        ],
      }),
    );
    renderSheet(42);

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitForTaskTitle("Reparaturziel");
    await userEvent.click(
      screen.getByRole("heading", { name: "Teilaufgaben", level: 3 }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Aufteilen" }));
    expect(
      await screen.findByRole("heading", { name: "Aufgabe aufteilen" }),
    ).toBeInTheDocument();
  });

  it("zeigt Projektkontext und Zuständigkeit als Werte, die den Zuweisen-Workflow öffnen", async () => {
    const inheritedTag = makeTag({ id: 11, name: "eilig" });
    mockedApi.getMembers.mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
      makeMember({ id: 2, name: "Jonas" }),
    ]);
    const task = makeTask({
      id: 42,
      title: "Bericht schreiben",
      projectId: 7,
      projectTitle: "Jahresbericht",
      projectOwnerMemberId: 1,
      ownerInheritanceMode: "inherit",
      effectiveOwnerId: 1,
      effectiveOwnerSource: "project",
      inheritedOwnerId: 1,
      effectiveTags: [inheritedTag],
      explicitTags: [],
      excludedTagIds: [],
    });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.updateTask.mockResolvedValue({
      ...task,
      revision: 2,
      ownerMemberId: 2,
      ownerInheritanceMode: "explicit",
    });

    renderSheet(42);
    await userEvent.click(screen.getByText("open"));
    expect(await waitForTaskTitle("Bericht schreiben")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Jahresbericht" })).toHaveAttribute(
      "href",
      "/projects/7",
    );
    expect(screen.getByText("eilig")).toBeInTheDocument();

    // The inherited owner is shown as an effective value, not as an
    // inheritance-mode picker the sheet implements itself.
    expect(
      screen.queryByRole("group", { name: "Zuständig" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Zuständig.*Mira/ }));

    await userEvent.click(
      await screen.findByRole("button", { name: "Jonas" }),
    );
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(42, {
        ownerMemberId: 2,
        ownerInheritanceMode: "explicit",
        expectedRevision: 1,
      }),
    );
  });

  it("closes the sheet when following the project context link", async () => {
    const task = makeTask({
      id: 43,
      title: "Bericht prüfen",
      projectId: 7,
      projectTitle: "Jahresbericht",
    });
    mockedApi.getTask.mockResolvedValue(task);
    renderSheet(43);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Bericht prüfen");

    await userEvent.click(screen.getByRole("link", { name: "Jahresbericht" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("bietet ohne Zuständige eine leichte Zuweisen-Aufforderung", async () => {
    const task = makeTask({ id: 57, title: "Verantwortung klären" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(57);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Verantwortung klären");

    // A shared task without an owner is valid work, so nothing is shown as
    // missing beyond the affordance itself.
    expect(screen.queryByText("Gemeinsam / offen")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "+ Zuweisen" }));

    await userEvent.click(await screen.findByRole("button", { name: "Mira" }));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(57, {
        ownerMemberId: 1,
        ownerInheritanceMode: "explicit",
        expectedRevision: 1,
      }),
    );
  });

  it("zeigt keinen manuellen Heute-Umschalter/-Haken mehr an", async () => {
    const task = makeTask({ id: 44, title: "Keller aufräumen" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(44);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Keller aufräumen");

    expect(screen.queryByText("Heute erledigen")).not.toBeInTheDocument();
    expect(screen.queryByText("Für heute markieren")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Für heute markieren" }),
    ).not.toBeInTheDocument();
  });

  it("shows status as a real button that opens the lifecycle chooser, matching the other meta pills", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 45, title: "Unaufdringliche Details", status: "actionable" }),
    );
    renderSheet(45);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Unaufdringliche Details");

    const heading = screen.getByRole("heading", { name: "Details" });
    const header = heading.closest<HTMLElement>(".sheet-header");
    expect(header).not.toBeNull();
    expect(within(header!).getByRole("button", { name: "Teilen" })).toBeInTheDocument();
    expect(within(header!).getByRole("button", { name: "Schließen" })).toHaveClass(
      "icon-action-button",
    );

    const statusButton = screen.getByRole("button", { name: /Status.*Machbar/ });
    expect(statusButton).toHaveClass("detail-meta-status-button");
  });

  async function openStatusChoices() {
    await userEvent.click(screen.getByRole("button", { name: /Status/ }));
    return screen.getByRole("group", { name: "Status" });
  }

  it("routes a completion through the shared child-policy lifecycle mutation", async () => {
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
    await waitForTaskTitle("Status korrekt ändern");

    const statuses = await openStatusChoices();
    await userEvent.click(within(statuses).getByRole("button", { name: "Erledigt" }));

    await waitFor(() =>
      expect(mockedApi.completeTask).toHaveBeenCalledWith(46, "leave_open", undefined, 1),
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
    await waitForTaskTitle("Wieder warten");

    const statuses = await openStatusChoices();
    await userEvent.click(within(statuses).getByRole("button", { name: "Irgendwann" }));

    await waitFor(() =>
      expect(mockedApi.transitionTaskStatus).toHaveBeenCalledWith(
        47,
        "someday",
        undefined,
        1,
      ),
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
    await waitForTaskTitle("Doch erledigt");

    const statuses = await openStatusChoices();
    await userEvent.click(within(statuses).getByRole("button", { name: "Erledigt" }));

    await waitFor(() =>
      expect(mockedApi.transitionTaskStatus).toHaveBeenCalledWith(
        48,
        "done",
        undefined,
        1,
      ),
    );
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(mockedApi.reopenTask).not.toHaveBeenCalled();
  });

  it("plans through the one focused planning workflow", async () => {
    const task = makeTask({ id: 56, title: "Wochenplanung", scheduledDate: "2026-09-04" });
    mockedApi.getTask.mockResolvedValue(task);
    renderSheet(56);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Wochenplanung");

    // The detail owns no date input; the existing planning value is a
    // command that reaches the same sheet as the rail and keyboard.
    expect(screen.queryByLabelText("Eingeplant für")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Eingeplant für.*04\.09\.2026/ }),
    );

    const shortcuts = await screen.findByRole("group", { name: "Schnell planen" });
    await userEvent.click(
      within(shortcuts).getByRole("button", { name: "Nicht geplant" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(56, {
        scheduledDate: null,
        dueDate: null,
        expectedRevision: 1,
      }),
    );
  });

  it("shows a deadline beside the planned date and edits both in one transaction", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({
        id: 59,
        title: "Fälligkeit planen",
        scheduledDate: "2026-09-10",
        dueDate: "2026-09-20",
      }),
    );
    renderSheet(59);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Fälligkeit planen");

    await userEvent.click(
      screen.getByRole("button", {
        name: /Eingeplant für.*10\.09\.2026.*Fällig 20\.09\.2026/,
      }),
    );

    const dueDate = await screen.findByLabelText("Fällig");
    fireEvent.change(dueDate, { target: { value: "13. September 2026" } });
    fireEvent.blur(dueDate);
    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(59, {
        scheduledDate: "2026-09-10",
        dueDate: "2026-09-13",
        expectedRevision: 1,
      }),
    );
  });

  it("shows a set priority as a value that opens the priority workflow", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 60, title: "Priorisierte Aufgabe", priority: 3 }),
    );
    renderSheet(60);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Priorisierte Aufgabe");

    expect(screen.queryByLabelText("Priorität")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Priorität.*3/ }));

    const choices = await screen.findByRole("group", { name: "Priorität" });
    expect(within(choices).getByRole("button", { name: "2" })).toBeInTheDocument();
    await userEvent.click(within(choices).getByRole("button", { name: "2" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(60, {
        priority: 2,
        expectedRevision: 1,
      }),
    );
  });

  it("omits rare unset properties entirely and keeps them reachable as commands", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 62, title: "Schlichte Aufgabe" }),
    );
    renderSheet(62);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Schlichte Aufgabe");

    // Unset rare properties get no value, no affordance and no empty control.
    expect(screen.queryByLabelText("Priorität")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Fällig")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "+ Priorität" }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("heading", { name: "Weitere Aktionen", level: 3 }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Priorität" }));
    expect(
      await screen.findByRole("group", { name: "Priorität" }),
    ).toBeInTheDocument();
  });

  it("shows an active recurrence as a value that opens the recurrence workflow", async () => {
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
    await waitForTaskTitle("Filter wechseln");

    expect(screen.queryByLabelText("Wiederholen nach Tagen")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Wiederholung.*Alle 7 Tage/ }),
    );

    expect(await screen.findByLabelText("Wiederholen nach Tagen")).toHaveValue(7);
    expect(screen.getByLabelText("Erlaubte Abweichung in Tagen")).toHaveValue(2);

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
    await waitForTaskTitle("Angebot prüfen");

    const metaRow = document.querySelector<HTMLElement>(".detail-meta-row")!;
    await userEvent.click(within(metaRow).getByRole("button", { name: "Tags" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Ausschließen" }),
    );
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(43, {
      excludedTagIds: [11],
      expectedRevision: 1,
    }));
  });

  it("persists notes only after their explicit localized Save action", async () => {
    const task = makeTask({ id: 45, title: "Wäsche waschen", notes: "" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(45);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Wäsche waschen");

    const notesField = await openNotesEditor();
    const notesContainer = notesField.closest<HTMLElement>(".task-notes-field")!;
    const saveButton = within(notesContainer).getByRole("button", {
      name: "Notizen speichern",
    });
    expect(saveButton).toBeDisabled();
    await userEvent.type(notesField, "Feinwäsche zuerst");

    expect(saveButton).toBeEnabled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    await userEvent.click(saveButton);
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(45, {
        notes: "Feinwäsche zuerst",
        expectedRevision: 1,
      }),
    );
  });

  it("cancels a notes draft without touching the server", async () => {
    const task = makeTask({ id: 58, title: "Ausflug planen", notes: "Alt" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(58);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Ausflug planen");

    const notesField = await openNotesEditor();
    const notesContainer = notesField.closest<HTMLElement>(".task-notes-field")!;
    await userEvent.clear(notesField);
    await userEvent.type(notesField, "Neue Notiz");
    await userEvent.click(
      within(notesContainer).getByRole("button", { name: "Abbrechen" }),
    );

    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(within(notesContainer).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(notesContainer).getByText("Alt")).toBeInTheDocument();
  });

  it("persists a title only after Edit and explicit Save", async () => {
    const task = makeTask({ id: 46, title: "Einkaufen", notes: "Milch" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(46);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Einkaufen");

    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    const titleField = await openTitleEditor();
    const titleContainer = titleField.closest<HTMLElement>(".field")!;
    const saveButton = within(titleContainer).getByRole("button", {
      name: "Speichern",
    });
    expect(saveButton).toBeDisabled();
    await userEvent.clear(titleField);
    await userEvent.type(titleField, "Einkaufen gehen");

    expect(saveButton).toBeEnabled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    await userEvent.click(saveButton);

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(46, {
        title: "Einkaufen gehen",
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
    await waitForTaskTitle("Gemeinsame Aufgabe");
    const notesField = await openNotesEditor();
    const notesContainer = notesField.closest<HTMLElement>(".task-notes-field")!;
    await userEvent.clear(notesField);
    await userEvent.type(notesField, "Mein lokaler Entwurf");
    await userEvent.click(
      within(notesContainer).getByRole("button", {
        name: "Notizen speichern",
      }),
    );

    await screen.findByText(
      "Dieser Eintrag wurde auf einem anderen Gerät geändert. Die neueste Version wurde geladen und dein Entwurf beibehalten.",
    );
    await waitFor(() => expect(mockedApi.getTask.mock.calls.length).toBeGreaterThan(1));
    expect(
      screen.getByText("Remote umbenannt", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Notizen")).toHaveValue("Mein lokaler Entwurf");

    await userEvent.click(
      within(notesContainer).getByRole("button", {
        name: "Notizen speichern",
      }),
    );
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenLastCalledWith(60, {
        notes: "Mein lokaler Entwurf",
        expectedRevision: 2,
      }),
    );
  });

  it("disables notes Save again when the draft returns to its baseline", async () => {
    const task = makeTask({ id: 47, title: "Rechnung prüfen", notes: "" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(47);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Rechnung prüfen");

    const notesField = await openNotesEditor();
    const saveButton = within(
      notesField.closest<HTMLElement>(".task-notes-field")!,
    ).getByRole("button", { name: "Notizen speichern" });

    await userEvent.type(notesField, "Beleg suchen");
    expect(saveButton).toBeEnabled();

    await userEvent.clear(notesField);
    expect(saveButton).toBeDisabled();
  });

  it("keeps title Save disabled for an invalid empty draft", async () => {
    const task = makeTask({ id: 48, title: "Termin vereinbaren", notes: "" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(48);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Termin vereinbaren");

    const titleField = await openTitleEditor();
    const saveButton = within(
      titleField.closest<HTMLElement>(".field")!,
    ).getByRole("button", { name: "Speichern" });
    await userEvent.clear(titleField);
    expect(saveButton).toBeDisabled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("behält bearbeitete Notizen bei einem Reload durch einen anderen Patch auf derselben Aufgabe", async () => {
    const task = makeTask({ id: 49, title: "Garten pflegen", notes: "alt" });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.updateTask.mockResolvedValue({ ...task, priority: 2 });

    renderSheet(49);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Garten pflegen");

    const notesField = await openNotesEditor();
    await userEvent.type(notesField, " neu");

    // Trigger an unrelated patch (priority change) which reloads this same task.
    await userEvent.click(
      screen.getByRole("heading", { name: "Weitere Aktionen", level: 3 }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Priorität" }));
    const choices = await screen.findByRole("group", { name: "Priorität" });
    await userEvent.click(within(choices).getByRole("button", { name: "2" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(49, {
      priority: 2,
      expectedRevision: 1,
    }));

    // The in-progress notes edit must survive the reload triggered above.
    expect(screen.getByLabelText("Notizen")).toHaveValue("alt neu");
  });

  it("klassifiziert eine Erfassung explizit als machbar und öffnet erst nach Erfolg die nächste", async () => {
    const first = makeTask({ id: 50, title: "Erste Erfassung", needsClarification: true });
    const second = makeTask({ id: 51, title: "Zweite Erfassung", needsClarification: true });
    mockedApi.getTask.mockImplementation(async (id) => (id === 50 ? first : second));

    renderQueueSheet([50, 51]);
    await userEvent.click(screen.getByText("open queue"));
    await waitForTaskTitle("Erste Erfassung");

    expect(screen.queryByRole("button", { name: "Speichern & weiter" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));

    await waitFor(() =>
      expect(mockedApi.clarifyTask).toHaveBeenCalledWith(50, 1),
    );
    expect(await waitForTaskTitle("Zweite Erfassung")).toBeInTheDocument();
  });

  it("behält bei einem Fehler die aktuelle Klärungsaufgabe und zeigt den Fehler an", async () => {
    const task = makeTask({ id: 52, title: "Nicht verlieren", needsClarification: true });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.clarifyTask.mockRejectedValueOnce(
      new Error("Speichern fehlgeschlagen"),
    );

    renderQueueSheet([52, 53]);
    await userEvent.click(screen.getByText("open queue"));
    await waitForTaskTitle("Nicht verlieren");

    await userEvent.click(screen.getByRole("button", { name: "Machbar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Speichern fehlgeschlagen");
    expect(screen.getByText("Nicht verlieren", { selector: "strong" })).toBeInTheDocument();
    expect(mockedApi.getTask).toHaveBeenCalledWith(52);
    expect(mockedApi.getTask).not.toHaveBeenCalledWith(53);
  });

  it("klärt bei gewöhnlichem Speichern oder Unschärfe nicht automatisch", async () => {
    const task = makeTask({ id: 54, title: "Roh erfasst", notes: "", needsClarification: true });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(54);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Roh erfasst");

    const notesField = await openNotesEditor();
    await userEvent.type(notesField, "Ergänzung");
    await userEvent.click(
      screen.getByRole("button", { name: "Notizen speichern" }),
    );

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalled());
    expect(mockedApi.updateTask).toHaveBeenLastCalledWith(54, {
      notes: "Ergänzung",
      expectedRevision: 1,
    });
  });

  it("klassifiziert eine Erfassung explizit als irgendwann", async () => {
    const task = makeTask({ id: 55, title: "Status wählen", needsClarification: true });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(55);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Status wählen");

    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Irgendwann" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(55, {
        status: "someday",
        expectedRevision: 1,
      }),
    );
  });

  it("converts a captured item and opens the captured-project handoff", async () => {
    const task = makeTask({
      id: 56,
      title: "Kinderzimmer renovieren",
      notes: "Farbe auswählen",
      needsClarification: true,
    });
    const project = makeProject({
      id: 80,
      title: "Kinderzimmer renovieren",
      notes: "Farbe auswählen",
    });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.convertTaskToStory.mockResolvedValue(project);

    renderQueueSheet([56]);
    await userEvent.click(screen.getByText("open queue"));
    await waitForTaskTitle("Kinderzimmer renovieren");
    await userEvent.click(
      screen.getByRole("button", { name: "In Schritte zerlegen" }),
    );

    await waitFor(() =>
      expect(mockedApi.convertTaskToStory).toHaveBeenCalledWith(56, {
        status: "backlog",
        expectedRevision: 1,
      }),
    );
    const handoff = await screen.findByRole("dialog", {
      name: "Kinderzimmer renovieren",
    });
    expect(
      within(handoff).getByRole("button", { name: strings.addNextAction }),
    ).toBeInTheDocument();
  });

  it("converts a captured item directly into the backlog", async () => {
    const task = makeTask({
      id: 57,
      title: "Vielleicht umziehen",
      needsClarification: true,
    });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(57);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Vielleicht umziehen");
    await userEvent.click(screen.getByRole("button", { name: "Backlog" }));

    await waitFor(() =>
      expect(mockedApi.convertTaskToStory).toHaveBeenCalledWith(57, {
        status: "backlog",
        expectedRevision: 1,
      }),
    );
  });

  async function openConversion() {
    await userEvent.click(
      screen.getByRole("heading", { name: "Weitere Aktionen", level: 3 }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Zum Projekt machen" }),
    );
  }

  it("shows project conversion for a normal standalone task with subtasks", async () => {
    const task = makeTask({
      id: 58,
      title: "Keller organisieren",
      status: "actionable",
      children: [
        makeTask({
          id: 59,
          parentTaskId: 58,
          title: "Regale ausmessen",
        }),
      ],
    });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(58);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Keller organisieren");

    await openConversion();
    await userEvent.click(
      await screen.findByRole("button", { name: "Ins Backlog" }),
    );

    await waitFor(() =>
      expect(mockedApi.convertTaskToStory).toHaveBeenCalledWith(58, {
        status: "backlog",
        expectedRevision: 1,
      }),
    );
  });

  it("explains in the one conversion workflow why non-standalone tasks cannot convert", async () => {
    mockedApi.getTask.mockResolvedValue(
      makeTask({ id: 60, title: "Teilaufgabe", parentTaskId: 58 }),
    );
    renderSheet(60);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Teilaufgabe");
    await openConversion();

    expect(
      await screen.findByText(
        "Nur eigenständige Aufgaben ohne Elternaufgabe und Projekt können zu einem Projekt werden.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Ins Backlog" }),
    ).not.toBeInTheDocument();
    expect(mockedApi.convertTaskToStory).not.toHaveBeenCalled();
  });

  it("uses the explicit active choice for normal task conversion", async () => {
    const task = makeTask({
      id: 62,
      title: "Aktiv machen",
      status: "actionable",
      ownerMemberId: 1,
      ownerInheritanceMode: "explicit",
      children: [makeTask({ id: 63, parentTaskId: 62 })],
    });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(62);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Aktiv machen");
    await openConversion();
    await userEvent.click(
      await screen.findByRole("button", { name: "Aktivieren" }),
    );

    await waitFor(() =>
      expect(mockedApi.convertTaskToStory).toHaveBeenCalledWith(62, {
        status: "active",
        expectedRevision: 1,
      }),
    );
  });

  it("keeps the task detail open and displays conversion errors", async () => {
    const task = makeTask({
      id: 64,
      title: "Nicht aktivierbar",
      status: "actionable",
    });
    mockedApi.getTask.mockResolvedValue(task);
    mockedApi.convertTaskToStory.mockRejectedValueOnce(
      Object.assign(new Error("invalid conversion"), {
        name: "ApiError",
        code: "role_conversion_invalid",
        details: { reason: "task_only_relations" },
      }),
    );

    renderSheet(64);
    await userEvent.click(screen.getByText("open"));
    await waitForTaskTitle("Nicht aktivierbar");
    await openConversion();
    await userEvent.click(
      await screen.findByRole("button", { name: "Aktivieren" }),
    );

    expect(
      await screen.findAllByText("Nicht aktivierbar"),
    ).not.toHaveLength(0);
    expect(
      await screen.findByText(
        "Diese Aufgabe kann erst in ein Projekt umgewandelt werden, wenn widersprechende Aufgaben-Eigenschaften entfernt wurden.",
      ),
    ).toBeInTheDocument();
  });
});
