import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { SwipeSettingsProvider } from "../lib/swipeSettings";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    getProjects: vi.fn(),
    getProject: vi.fn(),
    moveTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

/**
 * `renderWithProviders` (src/test/testUtils.tsx) hard-codes its own bare
 * `<MemoryRouter>` with no routes, so it can't observe an actual navigation.
 * This local wrapper mirrors the same provider stack but also declares a
 * `/projects/:id` route with a distinct marker, so clicking the "Zum
 * Projekt" chip can be asserted to have really navigated there — not just
 * that `navigate()` was called with the right string.
 */
function renderAtRootWithProjectRoute(ui: ReactElement) {
  function ProjectRouteMarker() {
    const { id } = useParams();
    return <div data-testid="project-page">Projektseite {id}</div>;
  }
  function Providers({ children }: { children: ReactNode }) {
    return (
      <IdentityProvider>
        <RefreshProvider>
          <SwipeSettingsProvider>
            <TaskDetailProvider>{children}</TaskDetailProvider>
          </SwipeSettingsProvider>
        </RefreshProvider>
      </IdentityProvider>
    );
  }
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Providers>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/projects/:id" element={<ProjectRouteMarker />} />
        </Routes>
      </Providers>
    </MemoryRouter>,
  );
}

/** Simulates a horizontal drag past the swipe threshold and releases it. */
function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".task-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

describe("TaskRow – project chip (navigate when assigned, assign when projectless)", () => {
  const umzug = makeProject({ id: 77, title: "Umzug nach Leipzig" });
  const garten = makeProject({ id: 78, title: "Garten winterfest machen" });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
    mockedApi.getProjects.mockResolvedValue([umzug, garten]);
  });

  describe("task already belongs to a project", () => {
    it("reveals an enabled 'Zum Projekt' chip via a left-swipe and navigates to /projects/:id", async () => {
      const task = makeTask({ id: 50, title: "Angebot erstellen", status: "actionable", projectId: 77 });
      const { container } = renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
      await screen.findByText("Angebot erstellen");

      swipe(container, -100);

      const chip = screen.getByRole("button", { name: "Zum Projekt" });
      expect(chip).toBeEnabled();

      await userEvent.click(chip);

      expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 77");
      // Using the chip must also close the strip, same as every other chip.
      expect(screen.queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
    });

    it("also navigates when the chip strip is opened via the ⋯ kebab (non-gesture access)", async () => {
      const task = makeTask({ id: 51, title: "Kunde kontaktieren", status: "actionable", projectId: 12 });
      renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
      await screen.findByText("Kunde kontaktieren");

      await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
      await userEvent.click(screen.getByRole("button", { name: "Zum Projekt" }));

      expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 12");
    });
  });

  describe("projectless task", () => {
    it("renders the same icon enabled as 'Projekt zuweisen' instead of a disabled dead end", async () => {
      const task = makeTask({ id: 52, title: "Wäsche waschen", status: "actionable", projectId: null });
      const { container } = renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
      await screen.findByText("Wäsche waschen");

      swipe(container, -100);

      const chip = screen.getByRole("button", { name: "Projekt zuweisen" });
      expect(chip).toBeEnabled();
      expect(chip).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.queryByRole("button", { name: "Zum Projekt" })).not.toBeInTheDocument();
    });

    it("opens the existing searchable/recent MoveTaskSheet project picker on click", async () => {
      window.localStorage.setItem("machbar:recent-destinations:project", JSON.stringify([78]));
      const task = makeTask({ id: 53, title: "Wäsche waschen", status: "actionable", projectId: null });
      renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
      await screen.findByText("Wäsche waschen");

      await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
      await userEvent.click(screen.getByRole("button", { name: "Projekt zuweisen" }));

      expect(await screen.findByRole("heading", { name: "In anderes Projekt verschieben" })).toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "Ziel suchen" })).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Zuletzt verwendet" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Garten winterfest machen" })).toBeInTheDocument();
      // No navigation ever happens for a task that had no project yet.
      expect(screen.queryByTestId("project-page")).not.toBeInTheDocument();
    });

    it("assigns the picked project on save, refreshes the list, and returns focus near the row", async () => {
      mockedApi.moveTask.mockResolvedValue(makeTask({ id: 54, projectId: 78 }));
      const task = makeTask({ id: 54, title: "Wäsche waschen", status: "actionable", projectId: null });
      renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
      await screen.findByText("Wäsche waschen");

      const kebab = screen.getByRole("button", { name: "Weitere Aktionen" });
      await userEvent.click(kebab);
      await userEvent.click(screen.getByRole("button", { name: "Projekt zuweisen" }));

      await userEvent.click(await screen.findByRole("button", { name: "Garten winterfest machen" }));
      await userEvent.click(screen.getByRole("button", { name: "Hierher verschieben" }));

      await waitFor(() =>
        expect(mockedApi.moveTask).toHaveBeenCalledWith(54, {
          parentTaskId: null,
          projectId: 78,
          expectedRevision: 1,
        }),
      );
      // The sheet closes on a successful save.
      expect(screen.queryByRole("heading", { name: "In anderes Projekt verschieben" })).not.toBeInTheDocument();
      // Focus returns to (the vicinity of) the row that opened the picker.
      await waitFor(() => expect(kebab).toHaveFocus());
    });

    it("does nothing and stays projectless when the picker is cancelled", async () => {
      const task = makeTask({ id: 55, title: "Wäsche waschen", status: "actionable", projectId: null });
      renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
      await screen.findByText("Wäsche waschen");

      const kebab = screen.getByRole("button", { name: "Weitere Aktionen" });
      await userEvent.click(kebab);
      await userEvent.click(screen.getByRole("button", { name: "Projekt zuweisen" }));
      await screen.findByRole("heading", { name: "In anderes Projekt verschieben" });

      await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));

      expect(screen.queryByRole("heading", { name: "In anderes Projekt verschieben" })).not.toBeInTheDocument();
      expect(mockedApi.moveTask).not.toHaveBeenCalled();
      await waitFor(() => expect(kebab).toHaveFocus());
    });

    it("keeps the picker open and reports the error when the assignment fails", async () => {
      mockedApi.moveTask.mockRejectedValue(new Error("Netzwerkfehler"));
      const task = makeTask({ id: 56, title: "Wäsche waschen", status: "actionable", projectId: null });
      renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
      await screen.findByText("Wäsche waschen");

      await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
      await userEvent.click(screen.getByRole("button", { name: "Projekt zuweisen" }));
      await userEvent.click(await screen.findByRole("button", { name: "Garten winterfest machen" }));
      await userEvent.click(screen.getByRole("button", { name: "Hierher verschieben" }));

      expect(await screen.findByText(/Netzwerkfehler/)).toBeInTheDocument();
      // The sheet stays open — nothing to navigate to and nothing lost.
      expect(screen.getByRole("heading", { name: "In anderes Projekt verschieben" })).toBeInTheDocument();
    });

    it("moves a projectless task's whole subtree coherently in a single call", async () => {
      mockedApi.moveTask.mockResolvedValue(makeTask({ id: 57, projectId: 78 }));
      const child = makeTask({ id: 58, title: "Wäsche sortieren", status: "actionable", projectId: null, parentTaskId: 57 });
      const parent = makeTask({
        id: 57,
        title: "Wäsche waschen",
        status: "actionable",
        projectId: null,
        children: [child],
      });
      renderAtRootWithProjectRoute(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);
      await screen.findByText("Wäsche waschen");
      await screen.findByText("Wäsche sortieren");

      // Open the picker from the parent row specifically (there are two
      // kebabs on screen — one per row).
      const kebabs = screen.getAllByRole("button", { name: "Weitere Aktionen" });
      await userEvent.click(kebabs[0]!);
      await userEvent.click(screen.getByRole("button", { name: "Projekt zuweisen" }));
      await userEvent.click(await screen.findByRole("button", { name: "Garten winterfest machen" }));
      await userEvent.click(screen.getByRole("button", { name: "Hierher verschieben" }));

      // A single subtree-preserving call for the parent — the API/server
      // side (`moveTask` → `cascadeProjectId`) takes care of
      // reassigning every descendant, so the child is never moved on its
      // own from here.
      await waitFor(() =>
        expect(mockedApi.moveTask).toHaveBeenCalledWith(57, {
          parentTaskId: null,
          projectId: 78,
          expectedRevision: 1,
        }),
      );
      expect(mockedApi.moveTask).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Wäsche sortieren")).toBeInTheDocument();
    });
  });
});
