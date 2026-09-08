import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import type { ProjectStatus } from "@machbar/shared";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { renderWithProviders } from "../test/testUtils";
import { ProjectStoryRow } from "./ProjectStoryRow";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";
import { ProjectActionsProvider } from "../lib/useProjectActions";
import { TaskActionsProvider } from "../lib/useTaskActions";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { TaskWorkflowProvider } from "../lib/taskWorkflowContext";
import { ProjectWorkflowProvider } from "../lib/projectWorkflowContext";
import { SwipeSettingsProvider } from "../lib/swipeSettings";
import { RailConfigProvider } from "../lib/railConfigContext";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { RETENTION_MS } from "../lib/useTaskActions";
import { api } from "../lib/api";
import type { ProjectWithActions } from "../lib/api";
import {
  makeCriterion,
  makeMember,
  makePhysicalContext,
  makeProject,
  makeTask,
} from "../test/fixtures";
import { formatExactLocalDate } from "../lib/relativeDate";
import "../styles/index.css";
import "./ProjectStoryRow.css";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getProject: vi.fn(),
    getTags: vi.fn(),
    createTag: vi.fn(),
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

/** Flushes the microtask queue (mutation `await`s) without depending on real timers. */
async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

function localDateAfter(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function Harness({
  story,
  variant = "card",
}: {
  story: ProjectWithActions;
  variant?: "compact" | "card";
}) {
  // Mirrors `App.tsx`: the row only dispatches semantic `story.*` commands,
  // and every focused workflow they open is rendered by the single host.
  mockedApi.getProject.mockResolvedValue({ ...story, tasks: [] });
  return (
    <>
      <ul>
        <ProjectStoryRow story={story} variant={variant} />
      </ul>
      <ProjectWorkflowHost />
    </>
  );
}

function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".story-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

/** Mirrors `renderWithProviders` but adds a `/projects/:id` marker route. */
function renderWithProjectRoute(ui: ReactElement) {
  function ProjectRouteMarker() {
    const { id } = useParams();
    return <div data-testid="project-page">Projektseite {id}</div>;
  }
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <IdentityProvider>
        <RefreshProvider>
          <SwipeSettingsProvider>
            <RailConfigProvider>
              <TaskActionsProvider>
                <ProjectActionsProvider>
                  <InteractionScopeProvider>
                    <TaskDetailProvider>
                      <TaskWorkflowProvider>
                        <ProjectWorkflowProvider>
                          <Routes>
                            <Route path="/" element={ui} />
                            <Route path="/projects/:id" element={<ProjectRouteMarker />} />
                          </Routes>
                        </ProjectWorkflowProvider>
                      </TaskWorkflowProvider>
                    </TaskDetailProvider>
                  </InteractionScopeProvider>
                </ProjectActionsProvider>
              </TaskActionsProvider>
            </RailConfigProvider>
          </SwipeSettingsProvider>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>,
  );
}

function openChips() {
  fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
  return screen.getByRole("group", { name: "Weitere Aktionen" });
}

async function openRailOverflow(group: HTMLElement) {
  await userEvent.click(within(group).getByText("Mehr …"));
}

function openLifecycleRail(container: HTMLElement) {
  swipe(container, 100);
  return screen.getByRole("group", { name: "Status" });
}

describe("ProjectStoryRow – status-appropriate lifecycle rail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), makeMember({ id: 2, name: "Noah" })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("activates a backlog story that already has a driver", async () => {
    const story = makeProject({
      id: 20,
      title: "Kellerregal bauen",
      status: "backlog",
      ownerMemberId: 1,
      nextAction: makeTask({ projectId: 20 }),
    });
    mockedApi.activateProject.mockResolvedValue({ ...story, status: "active" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Kellerregal bauen");

    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Aktiv machen" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockedApi.activateProject).toHaveBeenCalledWith(20, {
      expectedRevision: 1,
    });
    expect(container.querySelector(".story-row-content.retained")).toBeInTheDocument();
    expect(screen.getByText("Aktiv gemacht")).toBeInTheDocument();
  });

  it("completes an active story", async () => {
    const story = makeProject({ id: 21, title: "Urlaub planen", status: "active", ownerMemberId: 1 });
    mockedApi.completeProject.mockResolvedValue({ ...story, status: "completed" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Urlaub planen");

    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Abschließen" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeProject).toHaveBeenCalledWith(21, {
      expectedRevision: 1,
    });
    expect(screen.getByText("Abgeschlossen")).toBeInTheDocument();
  });

  it("reopens a completed story", async () => {
    const story = makeProject({
      id: 22,
      title: "Steuererklärung",
      status: "completed",
      ownerMemberId: 1,
      nextAction: makeTask({ projectId: 22 }),
    });
    mockedApi.reopenProject.mockResolvedValue({ ...story, status: "active" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Steuererklärung");

    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Wieder öffnen" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.reopenProject).toHaveBeenCalledWith(22, {
      expectedRevision: 1,
    });
    expect(screen.getByText("Wieder geöffnet")).toBeInTheDocument();
  });

  it("routes an unready reopen to next-action preparation", async () => {
    const story = makeProject({
      id: 25,
      title: "Abgeschlossen ohne nächsten Schritt",
      status: "completed",
      ownerMemberId: 1,
    });
    renderWithProjectRoute(<Harness story={story} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Wieder öffnen" }),
    );

    expect(await screen.findByTestId("project-page")).toHaveTextContent(
      "Projektseite 25",
    );
    expect(mockedApi.reopenProject).not.toHaveBeenCalled();
  });

  it("collects a missing driver and reopens atomically", async () => {
    const story = makeProject({
      id: 26,
      title: "Abgeschlossen ohne Driver",
      status: "completed",
      ownerMemberId: null,
      nextAction: makeTask({ projectId: 26 }),
    });
    mockedApi.reopenProject.mockResolvedValue({
      ...story,
      status: "active",
      ownerMemberId: 1,
    });
    const { container } = renderWithProviders(<Harness story={story} />);

    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Wieder öffnen" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Verantwortliche Person zuweisen",
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mira" }),
    );

    expect(mockedApi.reopenProject).toHaveBeenCalledWith(26, {
      expectedRevision: 1,
      ownerMemberId: 1,
    });
  });

  it("activates an archived story that still has its driver", async () => {
    const story = makeProject({
      id: 23,
      title: "Gartenhaus streichen",
      status: "archived",
      ownerMemberId: 2,
      nextAction: makeTask({ projectId: 23 }),
    });
    mockedApi.activateProject.mockResolvedValue({ ...story, status: "active" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Gartenhaus streichen");

    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Aktiv machen" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.activateProject).toHaveBeenCalledWith(23, {
      expectedRevision: 1,
    });
    expect(screen.getByText("Aktiv gemacht")).toBeInTheDocument();
  });

  it("never offers a transition the backend does not advertise", async () => {
    // A story whose legal actions were narrowed server-side: the primary
    // control must fall back to what is actually allowed.
    const story = makeProject({
      id: 24,
      title: "Sonderfall",
      status: "active",
      ownerMemberId: 1,
      availableActions: ["archive"],
    });
    mockedApi.archiveProject.mockResolvedValue({ ...story, status: "archived" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Sonderfall");

    expect(screen.getByRole("button", { name: "Archivieren" })).toBeInTheDocument();
    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Archivieren" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeProject).not.toHaveBeenCalled();
    expect(mockedApi.archiveProject).toHaveBeenCalledWith(24, {
      expectedRevision: 1,
    });
  });
});

describe("ProjectStoryRow – activation preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), makeMember({ id: 2, name: "Noah" })]);
  });

  it("continues activation immediately after selecting a missing driver", async () => {
    const story = makeProject({
      id: 30,
      title: "Ohne Driver backlog",
      status: "backlog",
      ownerMemberId: null,
      nextAction: makeTask({ projectId: 30 }),
    });
    mockedApi.activateProject.mockResolvedValue({ ...story, status: "active", ownerMemberId: 2 });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Ohne Driver backlog");

    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Aktiv machen" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Verantwortliche Person zuweisen",
    });
    expect(mockedApi.activateProject).not.toHaveBeenCalled();

    const group = within(dialog).getByRole("group", { name: "Verantwortlich" });
    expect(within(group).queryByRole("button", { name: "Niemand zugewiesen" })).not.toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Noah" }));

    // Assigning and activating happen in one atomic backend call.
    await waitFor(() =>
      expect(mockedApi.activateProject).toHaveBeenCalledWith(30, {
        expectedRevision: 1,
        ownerMemberId: 2,
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
  });

  it("keeps the focused driver sheet for archived activation", async () => {
    const story = makeProject({
      id: 31,
      title: "Ohne Driver archived",
      status: "archived",
      ownerMemberId: null,
      nextAction: makeTask({ projectId: 31 }),
    });
    mockedApi.activateProject.mockResolvedValue({
      ...story,
      status: "active",
      ownerMemberId: 2,
    });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Ohne Driver archived");

    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Aktiv machen" }));

    expect(
      await screen.findByRole("heading", {
        name: "Verantwortliche Person zuweisen",
      }),
    ).toBeInTheDocument();
  });

  it("asks for a driver when activating via the lifecycle rail of an archived story too", async () => {
    const story = makeProject({
      id: 32,
      title: "Archiv ohne Driver",
      status: "completed",
      ownerMemberId: null,
      availableActions: ["reopen", "activate"],
      nextAction: makeTask({ projectId: 32 }),
    });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Archiv ohne Driver");

    const lifecycle = openLifecycleRail(container);
    await userEvent.click(within(lifecycle).getByRole("button", { name: "Aktiv machen" }));

    expect(await screen.findByRole("heading", { name: "Verantwortliche Person zuweisen" })).toBeInTheDocument();
    expect(mockedApi.activateProject).not.toHaveBeenCalled();
  });
});

describe("ProjectStoryRow – left-swipe/kebab command rail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), makeMember({ id: 2, name: "Noah" })]);
  });

  it("reveals the default project rail commands plus More overflow for secondary commands", async () => {
    const story = makeProject({ id: 40, title: "Aktive Geschichte", status: "active", ownerMemberId: 1 });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Aktive Geschichte");

    swipe(container, -100);
    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });
    expect(within(chips).getByRole("button", { name: "Wiedervorlegen" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Verantwortliche Person" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Arbeit planen" })).toBeInTheDocument();
    expect(within(chips).getByText("Mehr …")).toBeInTheDocument();

    await openRailOverflow(chips);
    expect(within(chips).getByRole("button", { name: "Ergebnis bearbeiten" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Tags" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Kontext" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Status" })).toBeInTheDocument();
  });

  it("offers only legal transitions in the lifecycle rail for a completed and an archived story", async () => {
    const completed = makeProject({ id: 41, title: "Fertige Geschichte", status: "completed", ownerMemberId: 1 });
    const { container: completedContainer, unmount } = renderWithProviders(<Harness story={completed} />);
    await screen.findByText("Fertige Geschichte");
    let lifecycle = openLifecycleRail(completedContainer);
    expect(within(lifecycle).getByRole("button", { name: "Wieder öffnen" })).toBeInTheDocument();
    expect(within(lifecycle).getByRole("button", { name: "Archivieren" })).toBeInTheDocument();
    expect(within(lifecycle).queryByRole("button", { name: "Auf später verschieben" })).not.toBeInTheDocument();
    unmount();

    const archived = makeProject({ id: 42, title: "Archivierte Geschichte", status: "archived", ownerMemberId: 1 });
    const { container } = renderWithProviders(<Harness story={archived} />);
    await screen.findByText("Archivierte Geschichte");
    lifecycle = openLifecycleRail(container);
    expect(within(lifecycle).getByRole("button", { name: "Aktiv machen" })).toBeInTheDocument();
    expect(within(lifecycle).getByRole("button", { name: "Auf später verschieben" })).toBeInTheDocument();
    expect(within(lifecycle).queryByRole("button", { name: "Archivieren" })).not.toBeInTheDocument();
  });

  it("returns an active story to the backlog from the lifecycle rail", async () => {
    const story = makeProject({ id: 43, title: "Doch nicht jetzt", status: "active", ownerMemberId: 1 });
    mockedApi.returnProjectToBacklog.mockResolvedValue({ ...story, status: "backlog" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Doch nicht jetzt");

    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Auf später verschieben" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.returnProjectToBacklog).toHaveBeenCalledWith(43, {
      expectedRevision: 1,
    });
    expect(screen.getByText("Auf später verschoben")).toBeInTheDocument();
  });

  it("respects the driver invariant: an active story's driver can be reassigned but not cleared", async () => {
    const story = makeProject({ id: 44, title: "Driver-Regel", status: "active", ownerMemberId: 1 });
    mockedApi.updateProject.mockResolvedValue({ ...story, ownerMemberId: 2 });
    renderWithProviders(<Harness story={story} />);
    await screen.findByText("Driver-Regel");

    const chips = openChips();
    await userEvent.click(within(chips).getByRole("button", { name: "Verantwortliche Person" }));

    const group = screen.getByRole("group", { name: "Verantwortlich" });
    expect(within(group).queryByRole("button", { name: "Niemand zugewiesen" })).not.toBeInTheDocument();
    expect(
      screen.getByText("Die verantwortliche Person kann erst entfernt werden, wenn das Projekt wieder auf „Später / noch nicht aktiv“ steht."),
    ).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Noah" }));

    await waitFor(() => expect(mockedApi.updateProject).toHaveBeenCalledWith(44, {
      ownerMemberId: 2,
      expectedRevision: 1,
    }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // A driver change must never move the story through the workflow.
    expect(mockedApi.activateProject).not.toHaveBeenCalled();
    expect(mockedApi.completeProject).not.toHaveBeenCalled();
  });

  it("still allows clearing the driver of a backlog story", async () => {
    const story = makeProject({ id: 45, title: "Backlog-Driver", status: "backlog", ownerMemberId: 1 });
    renderWithProviders(<Harness story={story} variant="compact" />);
    await screen.findByText("Backlog-Driver");

    const chips = openChips();
    await userEvent.click(within(chips).getByRole("button", { name: "Verantwortliche Person" }));

    const group = screen.getByRole("group", { name: "Verantwortlich" });
    expect(within(group).getByRole("button", { name: "Niemand zugewiesen" })).toBeInTheDocument();
    expect(
      screen.queryByText("Die verantwortliche Person kann erst entfernt werden, wenn das Projekt wieder auf „Später / noch nicht aktiv“ steht."),
    ).not.toBeInTheDocument();
  });

  it("edits acceptance criteria and dates in targeted popups without leaving the list", async () => {
    const story = makeProject({
      id: 46,
      title: "Popup-Geschichte",
      status: "active",
      ownerMemberId: 1,
      acceptanceCriteria: [makeCriterion({ id: 91, projectId: 46, text: "Angebot eingeholt" })],
    });
    mockedApi.addCriterion.mockResolvedValue(story);
    mockedApi.updateProject.mockResolvedValue(story);
    renderWithProjectRoute(<Harness story={story} />);
    await screen.findByText("Popup-Geschichte");

    let chips = openChips();
    await openRailOverflow(chips);
    await userEvent.click(
      within(chips).getByRole("button", { name: "Ergebnis bearbeiten" }),
    );
    expect(screen.queryByTestId("project-page")).not.toBeInTheDocument();
    expect(await screen.findByDisplayValue("Angebot eingeholt")).toBeInTheDocument();
    // The sheet header and the criteria sheet's own footer button share the
    // "Schließen" label — the header one is the shared icon action.
    await userEvent.click(
      screen
        .getAllByRole("button", { name: "Schließen" })
        .find((b) => b.classList.contains("icon-action-button"))!,
    );

    chips = openChips();
    await userEvent.click(
      within(chips).getByRole("button", { name: "Wiedervorlegen" }),
    );
    // `story.defer` opens the canonical Wiedervorlage-first workflow (the
    // deadline is a secondary constraint behind its own affordance), not a
    // generic two-date form.
    const deferSheet = await screen.findByRole("dialog");
    expect(
      within(deferSheet).getByRole("heading", { name: "Wiedervorlegen" }),
    ).toBeInTheDocument();
    expect(
      within(deferSheet).getByText("Bis wann zurückstellen?"),
    ).toBeInTheDocument();
    await userEvent.click(
      within(deferSheet).getByRole("button", { name: "+ Deadline hinzufügen" }),
    );
    await userEvent.type(
      within(deferSheet).getByRole("textbox"),
      "1. Mai 2026",
    );
    await userEvent.click(
      within(deferSheet).getByRole("button", { name: "Speichern" }),
    );

    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenCalledWith(46, {
        dueDate: "2026-05-01",
        expectedRevision: 1,
      }),
    );
    expect(screen.queryByTestId("project-page")).not.toBeInTheDocument();
  });

  it("keeps only one story command rail open in the shared interaction scope", async () => {
    const first = makeProject({ id: 47, title: "Erste Rail", status: "active", ownerMemberId: 1 });
    const second = makeProject({ id: 48, title: "Zweite Rail", status: "active", ownerMemberId: 1 });
    renderWithProviders(
      <ul>
        <ProjectStoryRow story={first} />
        <ProjectStoryRow story={second} />
      </ul>,
    );
    await screen.findByText("Erste Rail");
    const firstRow = screen.getByText("Erste Rail").closest(".story-row") as HTMLElement;
    const secondRow = screen.getByText("Zweite Rail").closest(".story-row") as HTMLElement;

    await userEvent.click(within(firstRow).getByRole("button", { name: "Weitere Aktionen" }));
    expect(within(firstRow).getByRole("group", { name: "Weitere Aktionen" })).toBeInTheDocument();

    await userEvent.click(within(secondRow).getByRole("button", { name: "Weitere Aktionen" }));
    expect(within(secondRow).getByRole("group", { name: "Weitere Aktionen" })).toBeInTheDocument();
    expect(within(firstRow).queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
  });

  it("clears overflow state when the shared rail moves to another story", async () => {
    const first = makeProject({ id: 49, title: "Rail mit Overflow", status: "active", ownerMemberId: 1 });
    const second = makeProject({ id: 50, title: "Andere Rail", status: "active", ownerMemberId: 1 });
    renderWithProviders(
      <ul>
        <ProjectStoryRow story={first} />
        <ProjectStoryRow story={second} />
      </ul>,
    );
    await screen.findByText("Rail mit Overflow");
    const firstRow = screen.getByText("Rail mit Overflow").closest(".story-row") as HTMLElement;
    const secondRow = screen.getByText("Andere Rail").closest(".story-row") as HTMLElement;

    await userEvent.click(within(firstRow).getByRole("button", { name: "Weitere Aktionen" }));
    await openRailOverflow(within(firstRow).getByRole("group", { name: "Weitere Aktionen" }));
    expect(within(firstRow).getByRole("button", { name: "Tags" })).toBeInTheDocument();

    await userEvent.click(within(secondRow).getByRole("button", { name: "Weitere Aktionen" }));
    expect(within(secondRow).getByRole("group", { name: "Weitere Aktionen" })).toBeInTheDocument();
    expect(within(firstRow).queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
    expect(secondRow.querySelector(".work-item-command-overflow")).not.toHaveAttribute("open");
  });

  it("navigates to the project page through the explicit 'Arbeit planen' action", async () => {
    const story = makeProject({ id: 47, title: "Voll bearbeiten", status: "active", ownerMemberId: 1 });
    renderWithProjectRoute(<Harness story={story} />);
    await screen.findByText("Voll bearbeiten");

    const chips = openChips();
    await userEvent.click(within(chips).getByRole("button", { name: "Arbeit planen" }));
    expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 47");
  });
});

describe("ProjectStoryRow – non-gesture controls, status display and links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it.each<[ProjectStatus, string, string]>([
    ["backlog", "Später / noch nicht aktiv", "Aktiv machen"],
    ["active", "Aktiv", "Abschließen"],
    ["completed", "Abgeschlossen", "Wieder öffnen"],
    ["archived", "Archiviert", "Aktiv machen"],
  ])(
    "shows the current status (%s) and a labelled non-gesture primary control",
    async (status, statusLabel, actionLabel) => {
      const story = makeProject({ id: 50, title: `Status ${status}`, status, ownerMemberId: 1 });
      const { container } = renderWithProviders(<Harness story={story} />);
      await screen.findByText(`Status ${status}`);

      expect(container.querySelector(".story-row-status-badge")).toHaveTextContent(statusLabel);
      const primary = container.querySelector(".story-row-primary") as HTMLElement;
      expect(primary).toHaveAttribute("aria-label", actionLabel);
      expect(primary).not.toBeDisabled();

      // The kebab is the non-gesture equivalent of the left swipe.
      const kebab = screen.getByRole("button", { name: "Weitere Aktionen" });
      expect(kebab).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(kebab);
      expect(kebab).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("group", { name: "Weitere Aktionen" })).toBeInTheDocument();
    },
  );

  it("never offers the status as a dropdown: it is a read-only badge plus labelled action buttons", async () => {
    const story = makeProject({ id: 59, title: "Kein Dropdown", status: "active", ownerMemberId: 1 });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Kein Dropdown");

    // No `<select>` anywhere on the row — neither collapsed nor with the
    // command rail open.
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(container.querySelector("select")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(container.querySelector("select")).toBeNull();

    // The status itself is plain, non-interactive text with a spoken label …
    const badge = container.querySelector(".story-row-status-badge") as HTMLElement;
    expect(badge.tagName).toBe("SPAN");
    expect(badge).toHaveTextContent("Aktiv");
    expect(badge.closest("button")).toBeNull();
    expect(screen.getByText("Status:")).toHaveClass("sr-only");

    // … and every status change is an explicitly named lifecycle-rail button.
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    const lifecycle = openLifecycleRail(container);
    for (const label of ["Abschließen", "Auf später verschieben", "Archivieren"]) {
      expect(within(lifecycle).getByRole("button", { name: label })).toBeEnabled();
    }
    expect((container.querySelector(".story-row-primary") as HTMLElement).getAttribute("aria-label")).toBe(
      "Abschließen",
    );
  });

  it("performs the primary transition from the dedicated button, without any gesture", async () => {
    const story = makeProject({ id: 51, title: "Ohne Geste", status: "active", ownerMemberId: 1 });
    mockedApi.completeProject.mockResolvedValue({ ...story, status: "completed" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Ohne Geste");

    fireEvent.click(container.querySelector(".story-row-primary") as HTMLElement);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeProject).toHaveBeenCalledWith(51, {
      expectedRevision: 1,
    });
  });

  it("keeps tap-to-detail as a real link, but a swipe never navigates", async () => {
    const story = makeProject({ id: 52, title: "Tippen öffnet Detail", status: "active", ownerMemberId: 1 });
    mockedApi.completeProject.mockResolvedValue({ ...story, status: "completed" });
    const { container } = renderWithProjectRoute(<Harness story={story} />);
    await screen.findByText("Tippen öffnet Detail");

    const link = container.querySelector(".story-row-main") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("/projects/52");

    // Swiping the row must not open the detail page.
    swipe(container, 100);
    fireEvent.click(link);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.queryByTestId("project-page")).not.toBeInTheDocument();

    // A plain tap still does.
    fireEvent.click(container.querySelector(".story-row-main") as HTMLElement);
    expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 52");
  });

  it("takes pointer capture only once a real drag started, so plain clicks keep working", async () => {
    const story = makeProject({ id: 57, title: "Klicks bleiben klickbar", status: "active", ownerMemberId: 1 });
    const capture = vi.fn();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "setPointerCapture");
    Object.defineProperty(Element.prototype, "setPointerCapture", { value: capture, configurable: true });
    try {
      const { container } = renderWithProjectRoute(<Harness story={story} />);
      await screen.findByText("Klicks bleiben klickbar");
      const content = container.querySelector(".story-row-content") as HTMLElement;

      // A tap (no movement) must never capture the pointer: a captured
      // container also swallows the compatibility mouse events of the
      // buttons and the detail link inside it.
      fireEvent.pointerDown(content, { clientX: 40, pointerId: 1 });
      fireEvent.pointerUp(content, { clientX: 40, pointerId: 1 });
      expect(capture).not.toHaveBeenCalled();

      fireEvent.pointerDown(content, { clientX: 40, pointerId: 2 });
      fireEvent.pointerMove(content, { clientX: 44, pointerId: 2 });
      expect(capture).not.toHaveBeenCalled();
      fireEvent.pointerMove(content, { clientX: 120, pointerId: 2 });
      expect(capture).toHaveBeenCalledWith(2);
      fireEvent.pointerUp(content, { clientX: 120, pointerId: 2 });
    } finally {
      if (original) Object.defineProperty(Element.prototype, "setPointerCapture", original);
      else Reflect.deleteProperty(Element.prototype, "setPointerCapture");
    }
  });

  it("swallows only the click of the swipe itself, so tapping the row later still opens it", async () => {
    const story = makeProject({ id: 58, title: "Später antippen", status: "active", ownerMemberId: 1 });
    mockedApi.completeProject.mockResolvedValue({ ...story, status: "completed" });
    const { container } = renderWithProjectRoute(<Harness story={story} />);
    await screen.findByText("Später antippen");

    // Swipe without the browser ever emitting the trailing click …
    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    // … a later, unrelated tap must still navigate (a real tap always starts
    // with its own pointerdown, which resets the swallow flag).
    await userEvent.click(container.querySelector(".story-row-main") as HTMLElement);
    expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 58");
  });

  it("cancels an in-progress swipe without acting and keeps the row tappable", async () => {
    const story = makeProject({ id: 59, title: "Abgebrochene Geste", status: "active", ownerMemberId: 1 });
    const { container } = renderWithProjectRoute(<Harness story={story} />);
    await screen.findByText("Abgebrochene Geste");
    const content = container.querySelector(".story-row-content") as HTMLElement;

    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(content, { clientX: 100, pointerId: 1 });
    fireEvent.pointerCancel(content, { pointerId: 1 });

    expect(content.style.transform).toBe("");
    expect(mockedApi.completeProject).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".story-row-main") as HTMLElement);
    expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 59");
  });

  it("shows criteria and task progress on the card variant, and no free-text description", async () => {
    const story = makeProject({
      id: 53,
      title: "Umzug organisieren",
      status: "active",
      ownerMemberId: 1,
      openCount: 2,
      doneCount: 2,
      nextAction: makeTask({ id: 500, title: "Kartons kaufen" }),
      contexts: [
        makePhysicalContext({
          externalId: "zone.seligenstadt",
          name: "Seligenstadt",
        }),
      ],
      acceptanceCriteria: [
        makeCriterion({ text: "Wohnung gekündigt", checked: true }),
        makeCriterion({ text: "Übergabe abgeschlossen", checked: false }),
        makeCriterion({ text: "Kaution zurück", checked: false }),
      ],
    });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Umzug organisieren");

    expect(screen.getByText("Erledigt, wenn …: Übergabe abgeschlossen")).toBeInTheDocument();
    expect(screen.queryByText(/Aufgaben:/)).not.toBeInTheDocument();
    expect(screen.getByText("Nächster Schritt: Kartons kaufen")).toBeInTheDocument();
    expect(screen.getByLabelText("Verantwortlich: Mira")).toBeInTheDocument();
    const contextTag = screen.getByText("Seligenstadt");
    expect(contextTag).toHaveClass("task-card-tag");
    expect(contextTag.closest(".story-row-meta")).toBeInTheDocument();
    expect(screen.queryByText("Mira")).not.toBeInTheDocument();
    const progress = container.querySelector(".project-card-progress");
    expect(progress).toBeInTheDocument();
    expect(progress?.querySelectorAll(":scope > span")).toHaveLength(4);
    expect(progress?.querySelectorAll(":scope > .completed")).toHaveLength(2);
    expect(progress).toHaveAttribute("aria-valuetext", "2/4");
    expect(container.querySelector(".criteria-progress")).not.toBeInTheDocument();
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  });

  it("shows a scheduled next action with relative and exact local dates", async () => {
    const scheduledDate = localDateAfter(10);
    const exactDate = formatExactLocalDate(scheduledDate, "de");
    const story = makeProject({
      id: 60,
      title: "Wohnzimmer wischen",
      status: "active",
      ownerMemberId: 1,
      nextAction: makeTask({
        title: "Tisch und Teppich raus",
        scheduledDate,
      }),
    });
    renderWithProviders(<Harness story={story} />);

    const context = await screen.findByText(
      "Nächster Schritt in 10 Tagen: Tisch und Teppich raus",
    );
    expect(context).toHaveAttribute(
      "aria-label",
      `Nächster Schritt in 10 Tagen (${exactDate}): Tisch und Teppich raus`,
    );
    expect(context).toHaveAttribute(
      "title",
      `Nächster Schritt in 10 Tagen (${exactDate}): Tisch und Teppich raus`,
    );
  });

  it("keeps the plain next-action label when no schedule exists", async () => {
    renderWithProviders(
      <Harness
        story={makeProject({
          id: 61,
          title: "Direkt weitermachen",
          nextAction: makeTask({
            title: "Material holen",
            scheduledDate: null,
          }),
        })}
      />,
    );

    const context = await screen.findByText(
      "Nächster Schritt: Material holen",
    );
    expect(context).not.toHaveAttribute("aria-label");
    expect(context).not.toHaveAttribute("title");
  });

  it("omits the progress bar when there is nothing to show", async () => {
    const story = makeProject({ id: 54, title: "Ohne Kriterien", status: "backlog", acceptanceCriteria: [] });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Ohne Kriterien");

    expect(container.querySelector(".criteria-progress")).not.toBeInTheDocument();
    expect(container.querySelector(".project-card-progress")).not.toBeInTheDocument();
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    expect(screen.queryByText(/^Erledigt, wenn/)).not.toBeInTheDocument();
    expect(screen.getByText("Kein nächster Schritt")).toBeInTheDocument();
  });

  it("shows a completed result without a numerical criteria fraction", async () => {
    const story = makeProject({
      id: 55,
      title: "Ergebnis erreicht",
      acceptanceCriteria: [
        makeCriterion({ text: "Abgenommen", checked: true }),
        makeCriterion({ text: "Dokumentiert", checked: true }),
      ],
    });
    renderWithProviders(<Harness story={story} />);
    await screen.findByText("Ergebnis erreicht");

    expect(screen.getByText("Ergebnis vollständig")).toBeInTheDocument();
    expect(screen.queryByText(/2\/2/)).not.toBeInTheDocument();
  });
});

describe("ProjectStoryRow – retention, cycling and error rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a transitioned row visible for the retention window and disables it only while the request is in flight", async () => {
    vi.useFakeTimers();
    const story = makeProject({ id: 60, title: "Retention", status: "active", ownerMemberId: 1 });
    let resolveComplete: (value: ProjectWithActions) => void = () => {};
    mockedApi.completeProject.mockReturnValue(
      new Promise<ProjectWithActions>((resolve) => {
        resolveComplete = resolve;
      }),
    );
    const { container } = renderWithProviders(<Harness story={story} />);
    expect(screen.getByText("Retention")).toBeInTheDocument();

    fireEvent.click(container.querySelector(".story-row-primary") as HTMLElement);
    await act(async () => {
      await flushMicrotasks();
    });

    // In flight: optimistic, muted — and locked so the same story cannot be
    // mutated twice concurrently.
    expect(container.querySelector(".story-row-content.retained")).toBeInTheDocument();
    expect(screen.getByText("Abgeschlossen")).toBeInTheDocument();
    expect(container.querySelector(".story-row-primary")).toBeDisabled();

    await act(async () => {
      resolveComplete({ ...story, status: "completed", availableActions: ["reopen", "archive"] });
      await flushMicrotasks();
    });

    // Request resolved: still retained/muted, but actionable again.
    expect(container.querySelector(".story-row-content.retained")).toBeInTheDocument();
    expect(container.querySelector(".story-row-primary")).not.toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS - 500);
    });
    expect(screen.getByText("Retention")).toBeInTheDocument();
    expect(container.querySelector(".story-row-content.retained")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // Retention elapsed: the optimistic override is dropped (the harness keeps
    // rendering the unchanged prop, but no longer as a retained row).
    expect(container.querySelector(".story-row-content.retained")).not.toBeInTheDocument();
  });

  it("lets the workflow be cycled immediately: complete, then reopen the very same retained row", async () => {
    const story = makeProject({
      id: 61,
      title: "Zyklus",
      status: "active",
      ownerMemberId: 1,
      nextAction: makeTask({ projectId: 61 }),
    });
    mockedApi.completeProject.mockResolvedValue({
      ...story,
      status: "completed",
      availableActions: ["reopen", "archive"],
    });
    mockedApi.reopenProject.mockResolvedValue({ ...story, status: "active" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Zyklus");

    fireEvent.click(container.querySelector(".story-row-primary") as HTMLElement);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockedApi.completeProject).toHaveBeenCalledWith(61, {
      expectedRevision: 1,
    });

    // The retained row already advertises the *next* step of the cycle.
    await waitFor(() =>
      expect(container.querySelector(".story-row-primary")).toHaveAttribute("aria-label", "Wieder öffnen"),
    );

    fireEvent.click(container.querySelector(".story-row-primary") as HTMLElement);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.reopenProject).toHaveBeenCalledWith(61, {
      expectedRevision: 1,
    });
    expect(screen.getByText("Wieder geöffnet")).toBeInTheDocument();
  });

  it("rolls the row back and shows a dismissible inline error when the transition fails", async () => {
    const story = makeProject({ id: 62, title: "Fehlerfall", status: "active", ownerMemberId: 1 });
    mockedApi.completeProject.mockRejectedValue(new Error("Netzwerkfehler"));
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Fehlerfall");

    const lifecycle = openLifecycleRail(container);
    fireEvent.click(within(lifecycle).getByRole("button", { name: "Abschließen" }));
    await screen.findByText("Netzwerkfehler");

    // No retained optimistic state, and the row is back to its real status.
    expect(container.querySelector(".story-row-content.retained")).not.toBeInTheDocument();
    expect(container.querySelector(".story-row-status-badge")).toHaveTextContent("Aktiv");
    expect(container.querySelector(".story-row-primary")).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByText("Netzwerkfehler")).not.toBeInTheDocument();
  });
});

describe("ProjectStoryRow – configurable text command rail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it("renders the default project rail commands as labelled buttons with More overflow", async () => {
    const story = makeProject({ id: 70, title: "Kompakte Chips", status: "active", ownerMemberId: 1 });
    renderWithProviders(<Harness story={story} />);
    await screen.findByText("Kompakte Chips");

    const chips = openChips();
    for (const name of ["Wiedervorlegen", "Verantwortliche Person", "Arbeit planen"]) {
      const button = within(chips).getByRole("button", { name });
      expect(button).toHaveClass("btn", "btn-sm");
      expect(button.textContent).toBe(name);
    }

    expect(within(chips).getByText("Mehr …")).toBeInTheDocument();
    await openRailOverflow(chips);
    for (const name of ["Ergebnis bearbeiten", "Tags", "Kontext", "Status"]) {
      expect(within(chips).getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

describe("ProjectStoryRow – semantic status accents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[ProjectStatus, string]>([
    ["backlog", "backlog"],
    ["active", "active"],
    ["completed", "completed"],
    ["archived", "archived"],
  ])("gives a %s story its own distinct accent classes (not the same as any other status)", async (status, accent) => {
    const story = makeProject({
      id: 80,
      title: `Akzent ${status}`,
      status,
      ownerMemberId: 1,
      ...(status === "active" ? { nextAction: makeTask() } : {}),
    });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText(`Akzent ${status}`);

    expect(container.querySelector(".story-row")).toHaveClass(`story-row-accent-${accent}`);
    expect(container.querySelector(".story-row-status-badge")).toHaveClass(`story-row-status-badge--${accent}`);
    expect(container.querySelector(".story-row-primary")).toHaveClass(`story-row-primary--${accent}`);
  });

  it("marks active waiting as non-interactive info while keeping the active workflow actions unchanged", async () => {
    const waiting = makeProject({
      id: 81,
      title: "Wartet gesund",
      status: "active",
      ownerMemberId: 1,
      nextAction: null,
      stuckReason: null,
      waitingOn: ["Antwort vom Bauamt", "Liefertermin der Fenster"],
      waitingUntil: localDateAfter(14),
    });
    mockedApi.completeProject.mockResolvedValue({ ...waiting, status: "completed" });
    const { container } = renderWithProviders(<Harness story={waiting} />);
    await screen.findByText("Wartet gesund");

    const qualifier = screen.getByRole("img", { name: "Wartet" });
    expect(qualifier.tagName).toBe("SPAN");
    expect(qualifier.closest("button, a")).toBeNull();
    expect(qualifier).not.toHaveAttribute("tabindex");
    expect(container.querySelector(".story-row")).toHaveClass("story-row-accent-waiting");
    expect(container.querySelector(".story-row-status-badge")).toHaveClass("story-row-status-badge--waiting");
    expect(
      screen.getByText("Wartet auf: Antwort vom Bauamt · Liefertermin der Fenster · noch 2w"),
    ).toBeInTheDocument();
    expect(container.querySelector(".story-row-status-badge")).toHaveTextContent("Aktiv");

    const primary = screen.getByRole("button", { name: "Abschließen" });
    expect(primary).toHaveClass("story-row-primary--waiting");
    const lifecycle = openLifecycleRail(container);
    expect(within(lifecycle).getByRole("button", { name: "Auf später verschieben" })).toBeEnabled();
    expect(within(lifecycle).getByRole("button", { name: "Archivieren" })).toBeEnabled();
    expect(within(lifecycle).getByRole("button", { name: "Abschließen" })).toBeEnabled();

    fireEvent.click(within(lifecycle).getByRole("button", { name: "Abschließen" }));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockedApi.completeProject).toHaveBeenCalledWith(81, {
      expectedRevision: 1,
    });
  });

  it.each([
    ["2026-05-11", "Wiedervorlage: heute"],
    ["2026-05-09", "Wiedervorlage: 2 Tage überfällig"],
  ])(
    "shows a reached check-in on %s without stuck styling",
    (waitingUntil, expectedTiming) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-11T12:00:00"));
      const waiting = makeProject({
        id: 88,
        title: "Wartet auf Rückmeldung",
        status: "active",
        ownerMemberId: 1,
        nextAction: null,
        stuckReason: null,
        waitingOn: ["Rückmeldung der Werkstatt"],
        waitingUntil,
      });
      renderWithProviders(<Harness story={waiting} />);

      const summary = screen.getByText(
        new RegExp(`Wartet auf: Rückmeldung der Werkstatt.*${expectedTiming}`),
      );
      expect(summary).toHaveAttribute(
        "title",
        `Wiedervorlage am ${formatExactLocalDate(waitingUntil, "de")}`,
      );
      expect(summary.closest(".story-row")).toHaveClass(
        "story-row-accent-waiting",
      );
      expect(screen.queryByText("Dieses Projekt ist festgefahren")).not.toBeInTheDocument();
    },
  );

  it("limits a waiting summary to two reasons plus the remaining count", async () => {
    renderWithProviders(
      <Harness
        story={makeProject({
          id: 82,
          title: "Mehrere Rückmeldungen",
          status: "active",
          nextAction: null,
          stuckReason: null,
          waitingOn: ["Bauamt", "Vermieter", "Handwerker", "Versicherung"],
        })}
      />,
    );

    expect(
      await screen.findByText("Wartet auf: Bauamt · Vermieter · +2 weitere"),
    ).toBeInTheDocument();
  });

  it("explains when a waiting project has no usable reason", async () => {
    renderWithProviders(
      <Harness
        story={makeProject({
          id: 83,
          title: "Unklarer Wartegrund",
          status: "active",
          nextAction: null,
          stuckReason: null,
          waitingOn: [],
        })}
      />,
    );

    expect(
      await screen.findByText("Wartet – Grund nicht angegeben"),
    ).toBeInTheDocument();
  });

  it("keeps actionable active green and active stuck warning-colored, without the waiting marker", async () => {
    const actionable = makeProject({
      id: 82,
      title: "Direkt aktiv",
      status: "active",
      ownerMemberId: 1,
      nextAction: makeTask(),
      stuckReason: null,
    });
    const { container: actionableContainer, unmount } = renderWithProviders(<Harness story={actionable} />);
    await screen.findByText("Direkt aktiv");
    expect(actionableContainer.querySelector(".story-row")).toHaveClass("story-row-accent-active");
    expect(actionableContainer.querySelector(".story-row")).not.toHaveClass("story-row-accent-waiting");
    expect(screen.queryByRole("img", { name: "Wartet" })).not.toBeInTheDocument();
    unmount();

    const stuck = makeProject({
      id: 83,
      title: "Festgefahren aktiv",
      status: "active",
      ownerMemberId: 1,
      nextAction: null,
      stuckReason: "no_next_action",
    });
    const { container: stuckContainer } = renderWithProviders(<Harness story={stuck} />);
    await screen.findByText("Festgefahren aktiv");

    // Backlog is never rendered as green ("healthy"); a stuck active story
    // gets the same warning accent as a backlog story does not.
    expect(stuckContainer.querySelector(".story-row")).toHaveClass("story-row-accent-stuck");
    expect(stuckContainer.querySelector(".story-row")).not.toHaveClass("story-row-accent-active");
    expect(stuckContainer.querySelector(".story-row-status-badge")).toHaveClass("story-row-status-badge--stuck");
    expect(stuckContainer.querySelector(".story-row-primary")).toHaveClass("story-row-primary--stuck");
    expect(screen.queryByRole("img", { name: "Wartet" })).not.toBeInTheDocument();
  });

  it("never gives the backlog accent the same green used for a healthy active story", async () => {
    const backlog = makeProject({ id: 84, title: "Neu im Backlog", status: "backlog" });
    const { container } = renderWithProviders(<Harness story={backlog} />);
    await screen.findByText("Neu im Backlog");

    const badge = container.querySelector(".story-row-status-badge") as HTMLElement;
    expect(badge).toHaveClass("story-row-status-badge--backlog");
    expect(getComputedStyle(badge).color).not.toBe(getComputedStyle(document.createElement("div")).color);
    // The backlog badge must not reuse the exact green tone reserved for an
    // active/healthy story.
    const activeProbe = makeProject({
      id: 85,
      title: "Aktiv-Probe",
      status: "active",
      ownerMemberId: 1,
      nextAction: makeTask(),
    });
    const { container: activeContainer } = renderWithProviders(<Harness story={activeProbe} />);
    await screen.findByText("Aktiv-Probe");
    const activeBadge = activeContainer.querySelector(".story-row-status-badge") as HTMLElement;
    expect(getComputedStyle(badge).color).not.toBe(getComputedStyle(activeBadge).color);
  });
});
