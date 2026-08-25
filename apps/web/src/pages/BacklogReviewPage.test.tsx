import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { BacklogReviewPage } from "./BacklogReviewPage";
import { api } from "../lib/api";
import { makeCriterion, makeMember, makeProject } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getProjects: vi.fn(),
    updateProject: vi.fn(),
    activateProject: vi.fn(),
    archiveProject: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("BacklogReviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it("only shows stories still in the backlog, not active/completed/archived ones", async () => {
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 1, title: "Backlog-Geschichte", status: "backlog" }),
      makeProject({ id: 2, title: "Aktive Geschichte", status: "active" }),
      makeProject({ id: 3, title: "Fertige Geschichte", status: "completed" }),
      makeProject({ id: 4, title: "Archivierte Geschichte", status: "archived" }),
    ]);
    renderWithProviders(<BacklogReviewPage />);

    await screen.findByText("Backlog-Geschichte");
    expect(screen.queryByText("Aktive Geschichte")).not.toBeInTheDocument();
    expect(screen.queryByText("Fertige Geschichte")).not.toBeInTheDocument();
    expect(screen.queryByText("Archivierte Geschichte")).not.toBeInTheDocument();
  });

  it("shows the German empty state when there are no backlog stories", async () => {
    mockedApi.getProjects.mockResolvedValue([makeProject({ id: 5, title: "Läuft schon", status: "active" })]);
    renderWithProviders(<BacklogReviewPage />);

    expect(await screen.findByText("Keine Projekte unter „Später / noch nicht aktiv“.")).toBeInTheDocument();
  });

  it("renders criteria progress, driver, dates and task summary for each backlog story", async () => {
    mockedApi.getProjects.mockResolvedValue([
      makeProject({
        id: 6,
        title: "Wohnzimmer neu einrichten",
        status: "backlog",
        ownerMemberId: null,
        acceptanceCriteria: [makeCriterion({ id: 1, projectId: 6, checked: false })],
        openCount: 0,
        doneCount: 0,
      }),
    ]);
    renderWithProviders(<BacklogReviewPage />);

    await screen.findByText("Wohnzimmer neu einrichten");
    expect(screen.getByText(/Erledigt, wenn …: 0\/1/)).toBeInTheDocument();
    expect(screen.getByText("Niemand zugewiesen")).toBeInTheDocument();
    expect(screen.getByText(/Aufgaben: Noch keine Aufgaben/)).toBeInTheDocument();
  });

  it("shows the page header and a hint about the swipe/kebab interactions", async () => {
    mockedApi.getProjects.mockResolvedValue([]);
    renderWithProviders(<BacklogReviewPage />);

    expect(await screen.findByRole("heading", { name: "Projektklärung" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Noch nicht aktive Projekte prüfen, gezielt ergänzen und erst dann aktiv machen.",
      ),
    ).toBeInTheDocument();
  });
});
