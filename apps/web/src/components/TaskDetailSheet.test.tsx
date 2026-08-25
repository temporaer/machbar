import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider, useTaskDetail } from "../lib/taskDetailContext";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { api } from "../lib/api";
import { makeMember, makeTag, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    reopenTask: vi.fn(),
    deleteTask: vi.fn(),
    searchTasks: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function OpenerHarness({ taskId, children }: { taskId: number; children: ReactNode }) {
  const { open } = useTaskDetail();
  return (
    <div>
      <button type="button" onClick={() => open(taskId)}>
        open
      </button>
      {children}
    </div>
  );
}

function renderSheet(taskId: number) {
  return render(
    <MemoryRouter>
      <IdentityProvider>
        <RefreshProvider>
          <TaskDetailProvider>
            <OpenerHarness taskId={taskId}>
              <TaskDetailSheet />
            </OpenerHarness>
          </TaskDetailProvider>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>,
  );
}

describe("TaskDetailSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getTags.mockResolvedValue([makeTag({ id: 10, name: "büro" })]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
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

    await userEvent.click(screen.getByRole("button", { name: "Eigene Zuständigkeit setzen" }));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(42, { ownerInheritanceMode: "explicit" }));
  });

  it("zeigt keinen manuellen Heute-Umschalter/-Haken mehr an", async () => {
    const task = makeTask({ id: 44, title: "Keller aufräumen" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(44);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Keller aufräumen");

    expect(screen.queryByText("Heute erledigen")).not.toBeInTheDocument();
    expect(screen.queryByText("Für heute markieren")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
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
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(43, { excludedTagIds: [11] }));
  });

  it("aktiviert Änderungen speichern erst, nachdem die Notizen bearbeitet wurden", async () => {
    const task = makeTask({ id: 45, title: "Wäsche waschen", notes: "" });
    mockedApi.getTask.mockResolvedValue(task);

    renderSheet(45);
    await userEvent.click(screen.getByText("open"));
    await screen.findByDisplayValue("Wäsche waschen");

    const saveButton = screen.getByRole("button", { name: "Änderungen speichern" });
    expect(saveButton).toBeDisabled();

    const notesField = screen.getByLabelText("Notizen") as HTMLTextAreaElement;
    await userEvent.type(notesField, "Feinwäsche zuerst");

    expect(saveButton).toBeEnabled();
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
        context: null,
        waitingFor: null,
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
    const notesField = screen.getByLabelText("Notizen") as HTMLTextAreaElement;

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
    const notesField = screen.getByLabelText("Notizen") as HTMLTextAreaElement;
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

    const notesField = screen.getByLabelText("Notizen") as HTMLTextAreaElement;
    await userEvent.type(notesField, " neu");

    // Trigger an unrelated patch (priority change) which reloads this same task.
    await userEvent.selectOptions(screen.getByLabelText("Priorität"), "2");
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(49, { priority: 2 }));

    // The in-progress notes edit must survive the reload triggered above.
    expect(screen.getByLabelText("Notizen")).toHaveValue("alt neu");
  });
});
