import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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

  it("speichert Titel- und Kontextänderungen erst nach dem Verlassen des Felds (dirty save)", async () => {
    const project = makeProjectDetail({ id: 42, title: "Umzug organisieren" });
    mockedApi.updateProject.mockResolvedValue(project);

    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    const titleInput = await screen.findByDisplayValue("Umzug organisieren");
    const saveButton = screen.getByRole("button", { name: "Änderungen speichern" });
    expect(saveButton).toBeDisabled();

    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Umzug nach Berlin");
    expect(saveButton).not.toBeDisabled();
    expect(mockedApi.updateProject).not.toHaveBeenCalled();

    await userEvent.tab();
    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenCalledWith(42, {
        title: "Umzug nach Berlin",
        context: null,
      }),
    );
    await waitFor(() => expect(saveButton).toBeDisabled());
  });

  it("zeigt nur die für den aktuellen Status erlaubten Workflow-Aktionen an", async () => {
    const project = makeProjectDetail({
      id: 5,
      status: "backlog",
      availableActions: ["activate", "archive"],
    });
    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    await screen.findByDisplayValue(project.title);
    expect(screen.getByRole("button", { name: "Aktivieren" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archivieren" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abschließen" })).not.toBeInTheDocument();
  });

  it("zeigt den German-Fehler des Backends an, wenn die Aktivierung ohne Driver fehlschlägt", async () => {
    const project = makeProjectDetail({
      id: 7,
      status: "backlog",
      ownerMemberId: null,
      availableActions: ["activate", "archive"],
    });
    mockedApi.activateProject.mockRejectedValue(
      new Error(
        'Für die Aktivierung von "Beispielprojekt" muss zuerst eine verantwortliche Person (Driver) zugewiesen werden.',
      ),
    );
    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    await screen.findByDisplayValue(project.title);
    await userEvent.click(screen.getByRole("button", { name: "Aktivieren" }));

    expect(
      await screen.findByText(
        'Für die Aktivierung von "Beispielprojekt" muss zuerst eine verantwortliche Person (Driver) zugewiesen werden.',
      ),
    ).toBeInTheDocument();
  });

  it("fügt ein Akzeptanzkriterium hinzu, hakt es ab und entfernt es wieder", async () => {
    const criterion = makeCriterion({ id: 900, projectId: 42, text: "Kisten sind gepackt", checked: false });
    const project = makeProjectDetail({ id: 42, acceptanceCriteria: [criterion] });
    mockedApi.addCriterion.mockResolvedValue(project);
    mockedApi.checkCriterion.mockResolvedValue(project);
    mockedApi.removeCriterion.mockResolvedValue(project);

    renderWithProviders(<ProjectEditSheet project={project} onClose={vi.fn()} />);

    await screen.findByDisplayValue("Kisten sind gepackt");
    expect(screen.getByText("0/1 Akzeptanzkriterien")).toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText("Neues Akzeptanzkriterium"),
      "Umzugswagen ist gebucht",
    );
    await userEvent.click(screen.getByRole("button", { name: "Kriterium hinzufügen" }));
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
});
