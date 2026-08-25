import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { ProjectsPage } from "./ProjectsPage";
import { api } from "../lib/api";
import { makeCriterion, makeMember, makeProject } from "../test/fixtures";
import "../styles/index.css";
import "../components/ProjectStoryRow.css";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getProjects: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    activateProject: vi.fn(),
    returnProjectToBacklog: vi.fn(),
    completeProject: vi.fn(),
    reopenProject: vi.fn(),
    archiveProject: vi.fn(),
    addCriterion: vi.fn(),
    checkCriterion: vi.fn(),
    updateCriterion: vi.fn(),
    reorderCriteria: vi.fn(),
    removeCriterion: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

function swipeRow(row: HTMLElement, deltaX: number) {
  const content = row.querySelector(".story-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

function rowFor(container: HTMLElement, title: string): HTMLElement {
  const rows = [...container.querySelectorAll<HTMLElement>(".story-row")];
  const row = rows.find((r) => r.textContent?.includes(title));
  if (!row) throw new Error(`Keine Zeile für "${title}" gefunden`);
  return row;
}

describe("ProjectsPage – Scrum workflow on every row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getProjects.mockResolvedValue([
      makeProject({
        id: 70,
        title: "Backlog-Geschichte",
        status: "backlog",
        ownerMemberId: null,
        acceptanceCriteria: [makeCriterion({ id: 1, projectId: 70, checked: true })],
      }),
      makeProject({ id: 71, title: "Aktive Geschichte", status: "active", ownerMemberId: 1, openCount: 1, doneCount: 1 }),
      makeProject({ id: 72, title: "Fertige Geschichte", status: "completed", ownerMemberId: 1 }),
      makeProject({ id: 73, title: "Archivierte Geschichte", status: "archived", ownerMemberId: 1 }),
    ]);
  });

  it("shows the status of every project and its swipe hint", async () => {
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Backlog-Geschichte");

    expect(
      screen.getByText(
        "Nach rechts wischen führt den nächsten Workflow-Schritt aus, nach links wischen oder ⋯ zeigt weitere Aktionen.",
      ),
    ).toBeInTheDocument();
    const badges = [...container.querySelectorAll(".story-row-status-badge")].map((b) => b.textContent);
    expect(badges).toEqual(["Backlog", "Aktiv", "Abgeschlossen", "Archiviert"]);
  });

  it("changes a status only through named buttons, never through a status dropdown", async () => {
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Backlog-Geschichte");

    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(container.querySelector("select")).toBeNull();

    // Every row exposes its next workflow step as an explicitly labelled
    // control, and the status badge itself is not interactive.
    const expected: [string, string][] = [
      ["Backlog-Geschichte", "Aktivieren"],
      ["Aktive Geschichte", "Abschließen"],
      ["Fertige Geschichte", "Wieder öffnen"],
      ["Archivierte Geschichte", "Aktivieren"],
    ];
    for (const [title, label] of expected) {
      const row = rowFor(container, title);
      expect(row.querySelector(".story-row-primary")).toHaveAttribute("aria-label", label);
      expect((row.querySelector(".story-row-status-badge") as HTMLElement).closest("button")).toBeNull();
      fireEvent.click(within(row).getByRole("button", { name: "Weitere Aktionen" }));
      const chips = within(row).getByRole("group", { name: "Weitere Aktionen" });
      expect(within(chips).getAllByRole("button").length).toBeGreaterThan(0);
      expect(within(chips).queryAllByRole("combobox")).toHaveLength(0);
    }
  });

  it("completes an active project by swiping its row right, straight from the Projekte tab", async () => {
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Aktive Geschichte");
    mockedApi.completeProject.mockResolvedValue(
      makeProject({ id: 71, title: "Aktive Geschichte", status: "completed", ownerMemberId: 1 }),
    );

    swipeRow(rowFor(container, "Aktive Geschichte"), 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeProject).toHaveBeenCalledWith(71);
    expect(rowFor(container, "Aktive Geschichte").querySelector(".story-row-status-badge")).toHaveTextContent(
      "Abgeschlossen",
    );
  });

  it("asks for a driver when a backlog row without one is swiped, then activates atomically", async () => {
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Backlog-Geschichte");
    mockedApi.activateProject.mockResolvedValue(
      makeProject({ id: 70, title: "Backlog-Geschichte", status: "active", ownerMemberId: 1 }),
    );

    swipeRow(rowFor(container, "Backlog-Geschichte"), 100);
    expect(await screen.findByRole("heading", { name: "Verantwortliche Person zuweisen" })).toBeInTheDocument();

    const group = screen.getByRole("group", { name: "Verantwortlich" });
    fireEvent.click(within(group).getByRole("button", { name: "Mira" }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.activateProject).toHaveBeenCalledWith(70, { ownerMemberId: 1 }));
  });

  it("reveals per-row chips with the remaining legal transitions on a left swipe", async () => {
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Archivierte Geschichte");

    const row = rowFor(container, "Archivierte Geschichte");
    swipeRow(row, -100);
    const chips = within(row).getByRole("group", { name: "Weitere Aktionen" });
    expect(within(chips).getByRole("button", { name: "Verantwortlich" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "In Backlog zurücklegen" })).toBeInTheDocument();
    expect(within(chips).queryByRole("button", { name: "Archivieren" })).not.toBeInTheDocument();
  });

  it("keeps a retained row visible even when a refetch no longer lists it", async () => {
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Fertige Geschichte");
    mockedApi.reopenProject.mockResolvedValue(
      makeProject({ id: 72, title: "Fertige Geschichte", status: "active", ownerMemberId: 1 }),
    );
    // The next refetch drops the story from the list entirely.
    mockedApi.getProjects.mockResolvedValue([]);

    swipeRow(rowFor(container, "Fertige Geschichte"), 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.reopenProject).toHaveBeenCalledWith(72);
    expect(screen.getByText("Fertige Geschichte")).toBeInTheDocument();
    expect(screen.getByText("Wieder geöffnet")).toBeInTheDocument();
  });
});
