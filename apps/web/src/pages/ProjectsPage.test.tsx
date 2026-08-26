import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { ProjectsPage } from "./ProjectsPage";
import { IdentitySelector } from "../components/IdentitySelector";
import { api } from "../lib/api";
import { makeCriterion, makeMember, makeProject, makeTag } from "../test/fixtures";
import "../styles/index.css";
import "../components/ProjectStoryRow.css";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getProjects: vi.fn(),
    getTags: vi.fn().mockResolvedValue([]),
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
    // The default "Meine & offen" scope only shows the selected member's own
    // stories plus unassigned ones (see the dedicated filtering describe
    // block below) — this whole suite is about the workflow gestures, not
    // filtering, so it selects Mira up front to keep every fixture visible.
    window.localStorage.setItem("machbar:identity-member-id", "1");
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
    // New deterministic sort order: active healthy/stuck, then backlog,
    // completed, archived — not the fetch order.
    expect(badges).toEqual(["Aktiv", "Später / noch nicht aktiv", "Abgeschlossen", "Archiviert"]);
  });

  it("changes a status only through named buttons, never through a status dropdown", async () => {
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Backlog-Geschichte");

    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(container.querySelector("select")).toBeNull();

    // Every row exposes its next workflow step as an explicitly labelled
    // control, and the status badge itself is not interactive.
    const expected: [string, string][] = [
      ["Backlog-Geschichte", "Aktiv machen"],
      ["Aktive Geschichte", "Abschließen"],
      ["Fertige Geschichte", "Wieder öffnen"],
      ["Archivierte Geschichte", "Aktiv machen"],
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
    expect(within(chips).getByRole("button", { name: "Auf später verschieben" })).toBeInTheDocument();
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

  it("offers tag types instead of tag values and groups stories by the selected type", async () => {
    const phone = makeTag({ id: 91, name: "Telefon", kind: "context" });
    mockedApi.getProjects.mockResolvedValue([
      makeProject({
        id: 90,
        title: "Anruf erledigen",
        status: "active",
        effectiveTags: [phone],
      }),
      makeProject({ id: 92, title: "Ohne Kontext", status: "active" }),
    ]);

    renderWithProviders(<ProjectsPage />);
    await screen.findByText("Anruf erledigen");

    const grouping = screen.getByRole("group", { name: "Gruppieren nach" });
    expect(within(grouping).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Keine Gruppierung",
      "Kontext",
      "Person/Stelle",
      "Bereich",
    ]);
    expect(screen.queryByRole("button", { name: "Telefon" })).not.toBeInTheDocument();

    fireEvent.click(within(grouping).getByRole("button", { name: "Kontext" }));
    expect(screen.getByRole("heading", { name: "Telefon" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ohne Kontext" })).toBeInTheDocument();
  });
});

describe("ProjectsPage – search, visibility scope and sort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), makeMember({ id: 2, name: "Theo" })]);
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 1, title: "Miras aktive Geschichte", status: "active", ownerMemberId: 1 }),
      makeProject({
        id: 2,
        title: "Festgefahrene Geschichte",
        status: "active",
        ownerMemberId: 1,
        stuckReason: "no_next_action",
      }),
      makeProject({
        id: 3,
        title: "Küche renovieren",
        status: "backlog",
        ownerMemberId: null,
        acceptanceCriteria: [makeCriterion({ id: 30, projectId: 3, text: "Fliesen sind café-farben lackiert" })],
      }),
      makeProject({ id: 4, title: "Theos Geschichte", status: "active", ownerMemberId: 2 }),
    ]);
  });

  it("defaults the scope to the selected member's stories plus unassigned ones ('Meine & offen')", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    renderWithProviders(<ProjectsPage />);
    await screen.findByText("Miras aktive Geschichte");

    expect(screen.getByText("Festgefahrene Geschichte")).toBeInTheDocument();
    expect(screen.getByText("Küche renovieren")).toBeInTheDocument();
    expect(screen.queryByText("Theos Geschichte")).not.toBeInTheDocument();
  });

  it("shows only unassigned stories in the default scope when no identity is selected", async () => {
    renderWithProviders(<ProjectsPage />);
    await screen.findByText("Küche renovieren");

    expect(screen.queryByText("Miras aktive Geschichte")).not.toBeInTheDocument();
    expect(screen.queryByText("Festgefahrene Geschichte")).not.toBeInTheDocument();
    expect(screen.queryByText("Theos Geschichte")).not.toBeInTheDocument();
  });

  it("re-evaluates visibility immediately when the selected identity changes", async () => {
    renderWithProviders(
      <>
        <IdentitySelector />
        <ProjectsPage />
      </>,
    );
    await screen.findByText("Küche renovieren");
    expect(screen.queryByText("Theos Geschichte")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Theo/ }));

    await waitFor(() => expect(screen.getByText("Theos Geschichte")).toBeInTheDocument());
    expect(screen.queryByText("Miras aktive Geschichte")).not.toBeInTheDocument();
    expect(screen.getByText("Küche renovieren")).toBeInTheDocument();
  });

  it("the 'Alle' chip reveals every story regardless of owner", async () => {
    renderWithProviders(<ProjectsPage />);
    await screen.findByText("Küche renovieren");

    fireEvent.click(screen.getByRole("button", { name: "Alle" }));

    await waitFor(() => expect(screen.getByText("Theos Geschichte")).toBeInTheDocument());
    expect(screen.getByText("Miras aktive Geschichte")).toBeInTheDocument();
    expect(screen.getByText("Festgefahrene Geschichte")).toBeInTheDocument();
  });

  it("searches both the title and acceptance-criteria text, case-insensitively and diacritic-tolerantly", async () => {
    renderWithProviders(<ProjectsPage />);
    await screen.findByText("Küche renovieren");
    fireEvent.click(screen.getByRole("button", { name: "Alle" }));
    await screen.findByText("Theos Geschichte");

    const searchInput = screen.getByLabelText("Suchen");
    fireEvent.change(searchInput, { target: { value: "cafe" } });

    await waitFor(() => {
      expect(screen.getByText("Küche renovieren")).toBeInTheDocument();
      expect(screen.queryByText("Theos Geschichte")).not.toBeInTheDocument();
      expect(screen.queryByText("Miras aktive Geschichte")).not.toBeInTheDocument();
    });
  });

  it("sorts active-stuck stories after active-healthy ones but before backlog", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Miras aktive Geschichte");

    const titles = [...container.querySelectorAll(".story-row-title")].map((n) => n.childNodes[0]?.textContent);
    expect(titles).toEqual(["Miras aktive Geschichte", "Festgefahrene Geschichte", "Küche renovieren"]);
  });

  it("distinguishes 'no projects at all' from 'no projects match the filter'", async () => {
    mockedApi.getProjects.mockResolvedValue([]);
    renderWithProviders(<ProjectsPage />);
    expect(await screen.findByText("Keine Projekte vorhanden.")).toBeInTheDocument();
  });

  it("shows the filtered-empty state when stories exist but none match the current search", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    renderWithProviders(<ProjectsPage />);
    await screen.findByText("Miras aktive Geschichte");

    fireEvent.change(screen.getByLabelText("Suchen"), { target: { value: "nichts passt hier" } });

    expect(await screen.findByText("Keine Projekte für Suche/Filter.")).toBeInTheDocument();
    expect(screen.queryByText("Miras aktive Geschichte")).not.toBeInTheDocument();
  });

  it("keeps a retained row subject to the same filter/search and never duplicates it against a refetch", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Miras aktive Geschichte");
    mockedApi.completeProject.mockResolvedValue(
      makeProject({ id: 1, title: "Miras aktive Geschichte", status: "completed", ownerMemberId: 1 }),
    );
    // The refetch after completion still returns the same story — the
    // retained (optimistic) and refetched copies must not both render.
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 1, title: "Miras aktive Geschichte", status: "completed", ownerMemberId: 1 }),
      makeProject({
        id: 2,
        title: "Festgefahrene Geschichte",
        status: "active",
        ownerMemberId: 1,
        stuckReason: "no_next_action",
      }),
      makeProject({ id: 3, title: "Küche renovieren", status: "backlog", ownerMemberId: null }),
    ]);

    swipeRow(rowFor(container, "Miras aktive Geschichte"), 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeProject).toHaveBeenCalledWith(1);
    expect(screen.getAllByText("Miras aktive Geschichte")).toHaveLength(1);
  });
});

describe("ProjectsPage – completed/archived stories fold into one counted section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it("keeps active/backlog stories primary and folds completed+archived into one closed, counted section", async () => {
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 1, title: "Aktive Geschichte", status: "active", ownerMemberId: 1 }),
      makeProject({ id: 2, title: "Backlog-Geschichte", status: "backlog", ownerMemberId: null }),
      makeProject({ id: 3, title: "Fertige Geschichte", status: "completed", ownerMemberId: 1 }),
      makeProject({ id: 4, title: "Archivierte Geschichte", status: "archived", ownerMemberId: 1 }),
    ]);
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Aktive Geschichte");

    // Active/backlog rows are not nested inside any <details> fold.
    expect(rowFor(container, "Aktive Geschichte").closest("details")).toBeNull();
    expect(rowFor(container, "Backlog-Geschichte").closest("details")).toBeNull();

    const summary = screen.getByText("Abgeschlossen & archiviert (2)");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    // Folded by default — no search is active.
    expect(details).not.toHaveAttribute("open");
    expect(rowFor(container, "Fertige Geschichte").closest("details")).toBe(details);
    expect(rowFor(container, "Archivierte Geschichte").closest("details")).toBe(details);
  });

  it("shows only the folded section, with no empty primary list, when every matching story is terminal", async () => {
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 3, title: "Fertige Geschichte", status: "completed", ownerMemberId: 1 }),
      makeProject({ id: 4, title: "Archivierte Geschichte", status: "archived", ownerMemberId: 1 }),
    ]);
    const { container } = renderWithProviders(<ProjectsPage />);

    await screen.findByText("Abgeschlossen & archiviert (2)");
    const lists = container.querySelectorAll(".story-row-list");
    expect(lists).toHaveLength(1);
    expect(lists[0]?.closest("details")).not.toBeNull();
  });

  it("auto-opens the folded section when a non-empty search matches a terminal story", async () => {
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 1, title: "Aktive Geschichte", status: "active", ownerMemberId: 1 }),
      makeProject({ id: 3, title: "Küche gestrichen", status: "completed", ownerMemberId: 1 }),
    ]);
    renderWithProviders(<ProjectsPage />);
    await screen.findByText("Aktive Geschichte");

    fireEvent.change(screen.getByLabelText("Suchen"), { target: { value: "gestrichen" } });

    const match = await screen.findByText("Küche gestrichen");
    expect(match.closest("details")).toHaveAttribute("open");
  });

  it("folds the section shut again once a revealing search is cleared", async () => {
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 1, title: "Aktive Geschichte", status: "active", ownerMemberId: 1 }),
      makeProject({ id: 3, title: "Küche gestrichen", status: "completed", ownerMemberId: 1 }),
    ]);
    renderWithProviders(<ProjectsPage />);
    await screen.findByText("Aktive Geschichte");

    const searchInput = screen.getByLabelText("Suchen");
    fireEvent.change(searchInput, { target: { value: "gestrichen" } });
    const match = await screen.findByText("Küche gestrichen");
    expect(match.closest("details")).toHaveAttribute("open");

    fireEvent.change(searchInput, { target: { value: "" } });

    await waitFor(() => {
      const summary = screen.getByText("Abgeschlossen & archiviert (1)");
      expect(summary.closest("details")).not.toHaveAttribute("open");
    });
  });

  it("moves a story into the folded terminal section once it optimistically completes", async () => {
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 1, title: "Aktive Geschichte", status: "active", ownerMemberId: 1 }),
    ]);
    mockedApi.completeProject.mockResolvedValue(
      makeProject({ id: 1, title: "Aktive Geschichte", status: "completed", ownerMemberId: 1 }),
    );
    const { container } = renderWithProviders(<ProjectsPage />);
    await screen.findByText("Aktive Geschichte");
    expect(rowFor(container, "Aktive Geschichte").closest("details")).toBeNull();

    swipeRow(rowFor(container, "Aktive Geschichte"), 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeProject).toHaveBeenCalledWith(1);
    expect(screen.getByText("Abgeschlossen & archiviert (1)")).toBeInTheDocument();
    expect(rowFor(container, "Aktive Geschichte").closest("details")).not.toBeNull();
  });
});
