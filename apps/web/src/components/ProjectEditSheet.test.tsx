import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { ProjectEditSheet } from "./ProjectEditSheet";
import { api } from "../lib/api";
import type { ProjectDetail } from "../lib/api";
import { makeCriterion, makeMember, makeProject, makeTag } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    activateProject: vi.fn(),
    returnProjectToBacklog: vi.fn(),
    completeProject: vi.fn(),
    reopenProject: vi.fn(),
    archiveProject: vi.fn(),
    addCriterion: vi.fn(),
    updateCriterion: vi.fn(),
    checkCriterion: vi.fn(),
    reorderCriteria: vi.fn(),
    removeCriterion: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function makeProjectDetail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return { ...makeProject(), tasks: [], ...overrides };
}

describe("ProjectEditSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getTags.mockResolvedValue([makeTag({ id: 10, name: "büro" })]);
  });

  it("speichert den Titel ausschließlich über dessen lokalen Speichern-Button", async () => {
    const project = makeProjectDetail({ id: 42, title: "Umzug organisieren" });
    mockedApi.updateProject.mockResolvedValue({
      ...project,
      revision: 2,
      title: "Umzug nach Berlin",
    });

    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    const titleInput = await screen.findByDisplayValue("Umzug organisieren");
    expect(titleInput).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Änderungen speichern" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Projekttitel" }));
    expect(titleInput).toHaveFocus();
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Umzug nach Berlin");
    expect(mockedApi.updateProject).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Speichern: Projekttitel" }));
    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenCalledWith(42, {
        title: "Umzug nach Berlin",
        expectedRevision: 1,
      }),
    );
    expect(titleInput).toHaveAttribute("readonly");
  });

  it("stellt Titel und Notizen mit Abbrechen separat wieder her", async () => {
    const project = makeProjectDetail({
      id: 42,
      title: "Umzug organisieren",
      notes: "Alte Notiz",
    });
    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    const titleInput = await screen.findByDisplayValue("Umzug organisieren");
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Projekttitel" }));
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Verwerfen");
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen: Projekttitel" }));
    expect(titleInput).toHaveValue("Umzug organisieren");

    const notesInput = screen.getByLabelText("Notizen");
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Notizen" }));
    await userEvent.clear(notesInput);
    await userEvent.type(notesInput, "Auch verwerfen");
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen: Notizen" }));
    expect(notesInput).toHaveValue("Alte Notiz");
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
  });

  it("behält einen fehlgeschlagenen Notiz-Entwurf zum erneuten Speichern", async () => {
    const project = makeProjectDetail({ id: 42, notes: "Alt" });
    mockedApi.updateProject.mockRejectedValue(new Error("Speichern fehlgeschlagen"));
    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    const notesInput = await screen.findByLabelText("Notizen");
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Notizen" }));
    await userEvent.clear(notesInput);
    await userEvent.type(notesInput, "Wichtiger Entwurf");
    await userEvent.click(screen.getByRole("button", { name: "Speichern: Notizen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Speichern fehlgeschlagen");
    expect(notesInput).toHaveValue("Wichtiger Entwurf");
    expect(screen.getByRole("button", { name: "Speichern: Notizen" })).toBeEnabled();
  });

  it("verwendet nach aufeinanderfolgenden Feld-Saves jeweils die bestätigte Revision", async () => {
    const project = makeProjectDetail({ id: 42, title: "Alt", notes: "Vorher" });
    mockedApi.updateProject
      .mockResolvedValueOnce({ ...project, revision: 2, title: "Neu" })
      .mockResolvedValueOnce({ ...project, revision: 3, title: "Neu", notes: "Nachher" });
    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    const titleInput = await screen.findByDisplayValue("Alt");
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Projekttitel" }));
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Neu");
    await userEvent.click(screen.getByRole("button", { name: "Speichern: Projekttitel" }));

    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Notizen" }));
    const notesInput = screen.getByLabelText("Notizen");
    await userEvent.clear(notesInput);
    await userEvent.type(notesInput, "Nachher");
    await userEvent.click(screen.getByRole("button", { name: "Speichern: Notizen" }));

    await waitFor(() => expect(mockedApi.updateProject).toHaveBeenCalledTimes(2));
    expect(mockedApi.updateProject).toHaveBeenNthCalledWith(1, 42, {
      title: "Neu",
      expectedRevision: 1,
    });
    expect(mockedApi.updateProject).toHaveBeenNthCalledWith(2, 42, {
      notes: "Nachher",
      expectedRevision: 2,
    });
  });

  it("speichert Driver, Tags und Termine weiterhin sofort und revisionssicher", async () => {
    const office = makeTag({ id: 10, name: "büro" });
    const project = makeProjectDetail({ id: 42, ownerMemberId: null, tags: [] });
    mockedApi.updateProject
      .mockResolvedValueOnce({ ...project, revision: 2, ownerMemberId: 1 })
      .mockResolvedValueOnce({ ...project, revision: 3, ownerMemberId: 1, tags: [office] })
      .mockResolvedValueOnce({
        ...project,
        revision: 4,
        ownerMemberId: 1,
        tags: [office],
        dueDate: "2026-09-10",
      });
    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    await screen.findByDisplayValue(project.title);
    await userEvent.click(screen.getByRole("button", { name: /Mira/ }));
    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenNthCalledWith(1, 42, {
        ownerMemberId: 1,
        expectedRevision: 1,
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "büro" }));
    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenNthCalledWith(2, 42, {
        tagIds: [10],
        expectedRevision: 2,
      }),
    );

    const dueInput = screen.getByLabelText("Fällig");
    await userEvent.clear(dueInput);
    await userEvent.type(dueInput, "2026-09-10{Enter}");
    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenNthCalledWith(3, 42, {
        dueDate: "2026-09-10",
        expectedRevision: 3,
      }),
    );
  });

  it("schließt ohne offene Textentwürfe zu speichern", async () => {
    const onClose = vi.fn();
    const project = makeProjectDetail({ id: 42, title: "Bleibt" });
    renderWithProviders(<ProjectEditSheet project={project} onClose={onClose} />);

    const titleInput = await screen.findByDisplayValue("Bleibt");
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Projekttitel" }));
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Nicht speichern");
    await userEvent.click(screen.getByRole("button", { name: "Schließen" }));

    expect(onClose).toHaveBeenCalled();
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
    expect(titleInput).toHaveValue("Bleibt");
  });

  it("zeigt nur die für den aktuellen Status erlaubten Workflow-Aktionen an", async () => {
    const project = makeProjectDetail({
      id: 5,
      status: "backlog",
      availableActions: ["activate", "archive"],
    });
    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    await screen.findByDisplayValue(project.title);
    expect(screen.getByRole("button", { name: "Aktiv machen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archivieren" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abschließen" })).not.toBeInTheDocument();
  });

  it("zeigt den Status als nicht editierbares Badge – niemals als Dropdown", async () => {
    const project = makeProjectDetail({
      id: 6,
      status: "active",
      availableActions: ["complete", "return_to_backlog", "archive"],
    });
    const { container } = renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    await screen.findByDisplayValue(project.title);

    // Der Status wird angezeigt, aber nicht als Auswahlfeld angeboten.
    expect(screen.getByText("Status")).toHaveClass("field-label");
    expect(screen.getByText("Aktiv")).toHaveClass("badge");
    expect(screen.queryByRole("combobox", { name: "Status" })).not.toBeInTheDocument();
    expect(container.querySelector("#project-status")).toBeNull();
    for (const select of Array.from(container.querySelectorAll("select"))) {
      expect(select.id).not.toMatch(/status/i);
    }

    // Statuswechsel laufen ausschließlich über benannte Buttons in einer
    // beschrifteten Gruppe.
    const group = screen.getByRole("group", { name: "Status" });
    const actionLabels = within(group)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(actionLabels).toEqual(["Abschließen", "Auf später verschieben", "Archivieren"]);
  });

  it("fordert bei der Aktivierung einen Driver an und setzt denselben Befehl atomar fort", async () => {
    const project = makeProjectDetail({
      id: 7,
      status: "backlog",
      ownerMemberId: null,
      availableActions: ["activate", "archive"],
    });
    mockedApi.activateProject.mockResolvedValue({
      ...project,
      ownerMemberId: 1,
      status: "active",
      revision: 2,
      availableActions: ["complete", "return_to_backlog", "archive"],
    });
    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    await screen.findByDisplayValue(project.title);
    await userEvent.click(screen.getByRole("button", { name: "Aktiv machen" }));
    expect(mockedApi.activateProject).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Mira" }));
    await waitFor(() =>
      expect(mockedApi.activateProject).toHaveBeenCalledWith(7, {
        expectedRevision: 1,
        ownerMemberId: 1,
      }),
    );
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
  });

  it("verwirft eine ausstehende Aktivierung, sobald ein anderer Workflow-Befehl läuft", async () => {
    const project = makeProjectDetail({
      id: 8,
      status: "backlog",
      ownerMemberId: null,
      availableActions: ["activate", "archive"],
    });
    const archived = {
      ...project,
      status: "archived" as const,
      revision: 2,
      availableActions: ["activate" as const],
    };
    mockedApi.archiveProject.mockResolvedValue(archived);
    mockedApi.updateProject.mockResolvedValue({
      ...archived,
      ownerMemberId: 1,
      revision: 3,
    });
    renderWithProviders(
      <ProjectEditSheet project={project} onClose={vi.fn()} />,
    );

    await screen.findByDisplayValue(project.title);
    await userEvent.click(screen.getByRole("button", { name: "Aktiv machen" }));
    await userEvent.click(screen.getByRole("button", { name: "Archivieren" }));
    await waitFor(() =>
      expect(mockedApi.archiveProject).toHaveBeenCalledWith(8, {
        expectedRevision: 1,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Mira" }));

    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenCalledWith(8, {
        ownerMemberId: 1,
        expectedRevision: 2,
      }),
    );
    expect(mockedApi.activateProject).not.toHaveBeenCalled();
  });

  it("fügt ein Akzeptanzkriterium hinzu, hakt es ab und entfernt es wieder", async () => {
    const criterion = makeCriterion({ id: 900, projectId: 42, text: "Kisten sind gepackt", checked: false });
    const project = makeProjectDetail({ id: 42, acceptanceCriteria: [criterion] });
    mockedApi.addCriterion.mockResolvedValue(project);
    mockedApi.checkCriterion.mockResolvedValue(project);
    mockedApi.removeCriterion.mockResolvedValue(project);

    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    await screen.findByDisplayValue("Kisten sind gepackt");
    expect(screen.getByText("0/1 Erledigt, wenn …")).toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText("Erledigt, wenn …"),
      "Umzugswagen ist gebucht",
    );
    await userEvent.click(screen.getByRole("button", { name: "Punkt hinzufügen" }));
    await waitFor(() => expect(mockedApi.addCriterion).toHaveBeenCalledWith(42, "Umzugswagen ist gebucht"));

    await userEvent.click(screen.getByRole("checkbox", { name: "Kisten sind gepackt" }));
    await waitFor(() => expect(mockedApi.checkCriterion).toHaveBeenCalledWith(42, 900, true));

    await userEvent.click(screen.getByRole("button", { name: "Kriterium entfernen" }));
    await waitFor(() => expect(mockedApi.removeCriterion).toHaveBeenCalledWith(42, 900));
  });

  it("reorder-Buttons vertauschen die Kriterien-Reihenfolge über die API", async () => {
    const first = makeCriterion({ id: 1, projectId: 42, text: "Erstes Kriterium", position: 0 });
    const second = makeCriterion({ id: 2, projectId: 42, text: "Zweites Kriterium", position: 1 });
    const project = makeProjectDetail({ id: 42, acceptanceCriteria: [first, second] });
    mockedApi.reorderCriteria.mockResolvedValue(project);

    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    await screen.findByDisplayValue("Erstes Kriterium");
    const [, moveDownFirst] = screen.getAllByRole("button", { name: "Kriterium nach unten" });
    expect(moveDownFirst).toBeDefined();
    await userEvent.click(screen.getAllByRole("button", { name: "Kriterium nach unten" })[0]!);

    await waitFor(() => expect(mockedApi.reorderCriteria).toHaveBeenCalledWith(42, [2, 1]));
  });

  it("löscht ein Projekt erst nach Bestätigung", async () => {
    const project = makeProjectDetail({ id: 42, title: "Altes Projekt" });
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockedApi.deleteProject.mockResolvedValue(undefined);

    renderWithProviders(
      <ProjectEditSheet project={project} onClose={onClose} />,
    );

    await screen.findByDisplayValue("Altes Projekt");
    await userEvent.click(
      screen.getByRole("button", { name: "Projekt löschen" }),
    );

    expect(confirm).toHaveBeenCalledWith(
      "Projekt endgültig löschen? Die Aufgaben bleiben erhalten und werden keinem Projekt mehr zugeordnet.",
    );
    await waitFor(() =>
      expect(mockedApi.deleteProject).toHaveBeenCalledWith(42),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
