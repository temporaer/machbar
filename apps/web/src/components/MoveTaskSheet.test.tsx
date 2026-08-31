import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { makeProject, makeTask } from "../test/fixtures";
import { api } from "../lib/api";
import { MoveTaskSheet } from "./MoveTaskSheet";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getMembers: vi.fn(),
      getProjects: vi.fn(),
      getProject: vi.fn(),
      moveTask: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api);

/**
 * The refile destination pickers. These pin the search + recents behaviour
 * and, just as importantly, that the *candidate set* still excludes the
 * moved task's own subtree — the client-side half of the cycle protection
 * the API enforces server-side.
 */
describe("MoveTaskSheet", () => {
  const umzug = makeProject({ id: 1, title: "Umzug nach Leipzig" });
  const garten = makeProject({ id: 2, title: "Garten winterfest machen" });
  const steuer = makeProject({ id: 3, title: "Steuererklärung 2025" });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getProjects.mockResolvedValue([umzug, garten, steuer]);
    mockedApi.getProject.mockResolvedValue({ ...umzug, tasks: [] });
    mockedApi.moveTask.mockResolvedValue(makeTask() as never);
  });

  const rowNames = (group: HTMLElement) =>
    within(group)
      .getAllByRole("button")
      .map((b) => b.textContent);

  it("filters projects case-insensitively as you type — no native select", async () => {
    const task = makeTask({ id: 40, title: "Kartons besorgen", projectId: 1 });
    renderWithProviders(<MoveTaskSheet task={task} mode="project" onClose={vi.fn()} />);

    const search = await screen.findByRole("searchbox", { name: "Ziel suchen" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Umzug nach Leipzig" })).toBeInTheDocument();

    // Lower-case query against a capitalised title, matched mid-word.
    await userEvent.type(search, "gArTeN");

    expect(screen.getByRole("button", { name: "Garten winterfest machen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Umzug nach Leipzig" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Steuererklärung 2025" })).not.toBeInTheDocument();
  });

  it("reports an empty result set instead of an empty list", async () => {
    const task = makeTask({ id: 41, title: "Kartons besorgen", projectId: 1 });
    renderWithProviders(<MoveTaskSheet task={task} mode="project" onClose={vi.fn()} />);

    const search = await screen.findByRole("searchbox", { name: "Ziel suchen" });
    await userEvent.type(search, "zzz");

    expect(screen.getByText("Kein Ziel passt zu dieser Suche.")).toBeInTheDocument();
  });

  it("moves to the tapped project and remembers it as a recent destination", async () => {
    const onClose = vi.fn();
    const task = makeTask({ id: 42, title: "Kartons besorgen", projectId: 1 });
    renderWithProviders(<MoveTaskSheet task={task} mode="project" onClose={onClose} />);

    const target = await screen.findByRole("button", { name: "Garten winterfest machen" });
    await userEvent.click(target);
    expect(target).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Hierher verschieben" }));

    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(42, {
        parentTaskId: null,
        projectId: 2,
        expectedRevision: 1,
      }),
    );
    expect(onClose).toHaveBeenCalled();
    expect(window.localStorage.getItem("machbar:recent-destinations:project")).toBe("[2]");
  });

  it("lists recently used destinations first when no query is typed", async () => {
    window.localStorage.setItem("machbar:recent-destinations:project", JSON.stringify([3, 2]));
    const task = makeTask({ id: 43, title: "Kartons besorgen", projectId: 1 });
    renderWithProviders(<MoveTaskSheet task={task} mode="project" onClose={vi.fn()} />);

    const recents = await screen.findByRole("group", { name: "Zuletzt verwendet" });
    expect(rowNames(recents)).toEqual(["Steuererklärung 2025", "Garten winterfest machen"]);

    // The remaining projects follow, without repeating the recents.
    const rest = screen.getByRole("group", { name: "Alle Ziele" });
    expect(rowNames(rest)).toEqual(["Umzug nach Leipzig"]);
  });

  it("orders non-recent project destinations by lifecycle and title", async () => {
    mockedApi.getProjects.mockResolvedValue([
      makeProject({ id: 6, title: "Zulu", status: "backlog" }),
      makeProject({ id: 5, title: "Archiv", status: "archived" }),
      makeProject({ id: 4, title: "Änderung", status: "active" }),
      makeProject({ id: 7, title: "Abschluss", status: "completed" }),
    ]);
    renderWithProviders(
      <MoveTaskSheet
        task={makeTask({ id: 46, projectId: 4 })}
        mode="project"
        onClose={vi.fn()}
      />,
    );

    const destinations = await screen.findByRole("group", {
      name: "Projekt wählen",
    });
    expect(rowNames(destinations)).toEqual([
      "Änderung",
      "Zulu",
      "Abschluss",
      "Archiv",
    ]);
  });

  it("discards recent destinations that no longer exist", async () => {
    // 99 was archived/deleted since it was last used.
    window.localStorage.setItem("machbar:recent-destinations:project", JSON.stringify([99, 2]));
    const task = makeTask({ id: 44, title: "Kartons besorgen", projectId: 1 });
    renderWithProviders(<MoveTaskSheet task={task} mode="project" onClose={vi.fn()} />);

    const recents = await screen.findByRole("group", { name: "Zuletzt verwendet" });
    expect(rowNames(recents)).toEqual(["Garten winterfest machen"]);
  });

  it("hides the recents section entirely once a query is typed", async () => {
    window.localStorage.setItem("machbar:recent-destinations:project", JSON.stringify([3]));
    const task = makeTask({ id: 45, title: "Kartons besorgen", projectId: 1 });
    renderWithProviders(<MoveTaskSheet task={task} mode="project" onClose={vi.fn()} />);

    const search = await screen.findByRole("searchbox", { name: "Ziel suchen" });
    expect(screen.getByRole("group", { name: "Zuletzt verwendet" })).toBeInTheDocument();

    await userEvent.type(search, "umzug");
    expect(screen.queryByRole("group", { name: "Zuletzt verwendet" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Umzug nach Leipzig" })).toBeInTheDocument();
  });

  describe("parent picker", () => {
    const child = makeTask({ id: 51, title: "Kartons kaufen", projectId: 1, parentTaskId: 50 });
    const moved = makeTask({
      id: 50,
      title: "Packen vorbereiten",
      projectId: 1,
      children: [child],
    });
    const sibling = makeTask({ id: 60, title: "Möbelwagen mieten", projectId: 1 });

    beforeEach(() => {
      mockedApi.getProject.mockResolvedValue({ ...umzug, tasks: [moved, sibling] });
    });

    it("excludes the moved task and its descendants from the candidates", async () => {
      renderWithProviders(<MoveTaskSheet task={moved} mode="parent" onClose={vi.fn()} />);

      expect(await screen.findByRole("button", { name: /Möbelwagen mieten/ })).toBeInTheDocument();
      // Neither the task itself nor its child may become its own parent.
      expect(screen.queryByRole("button", { name: /Packen vorbereiten/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Kartons kaufen/ })).not.toBeInTheDocument();
    });

    it("finds parent candidates by their project title, not just their own", async () => {
      renderWithProviders(<MoveTaskSheet task={moved} mode="parent" onClose={vi.fn()} />);

      const search = await screen.findByRole("searchbox", { name: "Ziel suchen" });
      await userEvent.type(search, "leipzig");

      // "Möbelwagen mieten" has no match in its own title — it survives
      // because it sits in "Umzug nach Leipzig".
      expect(screen.getByRole("button", { name: /Möbelwagen mieten/ })).toBeInTheDocument();
    });

    it("keeps the top-level choice and records the chosen parent as recent", async () => {
      renderWithProviders(<MoveTaskSheet task={moved} mode="parent" onClose={vi.fn()} />);

      expect(await screen.findByRole("button", { name: "Keine (oberste Ebene)" })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /Möbelwagen mieten/ }));
      await userEvent.click(screen.getByRole("button", { name: "Hierher verschieben" }));

      await waitFor(() =>
        expect(mockedApi.moveTask).toHaveBeenCalledWith(50, {
          parentTaskId: 60,
          expectedRevision: 1,
        }),
      );
      expect(window.localStorage.getItem("machbar:recent-destinations:parent")).toBe("[60]");
    });

    it("moves a whole subtree through both pickers at once", async () => {
      renderWithProviders(<MoveTaskSheet task={moved} mode="subtree" onClose={vi.fn()} />);

      await screen.findByRole("button", { name: "Garten winterfest machen" });
      const [projectSearch, parentSearch] = screen.getAllByRole("searchbox", {
        name: "Ziel suchen",
      });
      expect(parentSearch).toBeDefined();

      await userEvent.type(projectSearch!, "garten");
      await userEvent.click(screen.getByRole("button", { name: "Garten winterfest machen" }));

      await userEvent.click(screen.getByRole("button", { name: "Hierher verschieben" }));

      await waitFor(() =>
        expect(mockedApi.moveTask).toHaveBeenCalledWith(50, {
          projectId: 2,
          // Switching project resets the parent — a parent from the old
          // project would be an illegal destination in the new one.
          parentTaskId: null,
          expectedRevision: 1,
        }),
      );
      expect(window.localStorage.getItem("machbar:recent-destinations:project")).toBe("[2]");
    });
  });
});
