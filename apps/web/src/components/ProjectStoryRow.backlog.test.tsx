import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { renderWithProviders } from "../test/testUtils";
import { ProjectStoryRow } from "./ProjectStoryRow";
import { useProjectWorkflowActions } from "../lib/useProjectWorkflowActions";
import { RETENTION_MS } from "../lib/useTaskActions";
import { api } from "../lib/api";
import { makeCriterion, makeMember, makeProject } from "../test/fixtures";
import "../styles/index.css";
import "./../pages/BacklogReviewPage.css";
import "./ProjectStoryRow.css";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    updateProject: vi.fn(),
    activateProject: vi.fn(),
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

function Harness({ story }: { story: ReturnType<typeof makeProject> }) {
  const actions = useProjectWorkflowActions();
  return (
    <ul>
      <ProjectStoryRow story={story} actions={actions} />
    </ul>
  );
}

function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".story-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

/**
 * `renderWithProviders` (see `test/testUtils.tsx`) hard-codes a bare
 * `<MemoryRouter>` with no routes, so it can't observe a real navigation.
 * This mirrors the same provider stack plus a `/projects/:id` marker route,
 * so navigating there via a chip can be asserted directly (see
 * `TaskRow.toProjectChip.test.tsx` for the identical pattern).
 */
function renderAtRootWithProjectRoute(ui: ReactElement) {
  function ProjectRouteMarker() {
    const { id } = useParams();
    return <div data-testid="project-page">Projektseite {id}</div>;
  }
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <IdentityProvider>
        <RefreshProvider>
          <Routes>
            <Route path="/" element={ui} />
            <Route path="/projects/:id" element={<ProjectRouteMarker />} />
          </Routes>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>,
  );
}

describe("ProjectStoryRow – Backlog Review (compact variant)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), makeMember({ id: 2, name: "Noah" })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows criteria, dates, task summary, and a lower-right driver avatar", async () => {
    const story = makeProject({
      id: 10,
      title: "Wohnzimmer neu einrichten",
      status: "backlog",
      ownerMemberId: 1,
      dueDate: "2026-03-01",
      scheduledDate: "2026-02-15",
      openCount: 2,
      doneCount: 1,
      acceptanceCriteria: [
        makeCriterion({ id: 1, projectId: 10, checked: true }),
        makeCriterion({ id: 2, projectId: 10, checked: false }),
      ],
    });
    renderWithProviders(<Harness story={story} />);
    await screen.findByText("Wohnzimmer neu einrichten");
    expect(await screen.findByLabelText("Verantwortlich: Mira")).toBeInTheDocument();
    expect(screen.queryByText("Mira")).not.toBeInTheDocument();

    expect(screen.getByText(/Erledigt, wenn …: 1\/2/)).toBeInTheDocument();
    expect(screen.getByText(/Fällig: 01.03.2026/)).toBeInTheDocument();
    expect(screen.getByText(/Geplant: 15.02.2026/)).toBeInTheDocument();
    expect(screen.getByText(/Aufgaben: 1\/3/)).toBeInTheDocument();
  });

  it("omits the avatar and task-count fraction when the story has no driver/tasks yet", async () => {
    const story = makeProject({ id: 11, title: "Fahrrad-Service planen", status: "backlog", ownerMemberId: null });
    renderWithProviders(<Harness story={story} />);
    await screen.findByText("Fahrrad-Service planen");

    expect(screen.queryByLabelText(/Verantwortlich:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Niemand zugewiesen")).not.toBeInTheDocument();
    expect(screen.getByText(/Aufgaben: Noch keine Aufgaben/)).toBeInTheDocument();
  });

  it("activates a story with a driver on a right swipe past the threshold", async () => {
    const story = makeProject({ id: 12, title: "Garten aufräumen", status: "backlog", ownerMemberId: 1 });
    mockedApi.activateProject.mockResolvedValue({ ...story, status: "active" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Garten aufräumen");

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.activateProject).toHaveBeenCalledWith(12, undefined);
    // Optimistic: still shown, muted, with the new status while retained.
    expect(screen.getByText("Garten aufräumen")).toBeInTheDocument();
    expect(container.querySelector(".story-row-content.retained")).toBeInTheDocument();
    expect(screen.getByText("Aktiv gemacht")).toBeInTheDocument();
  });

  it("reveals the driver-assignment sheet instead of failing when right-swiping a story without a driver, then activates once one is picked", async () => {
    const story = makeProject({ id: 13, title: "Homeoffice-Ecke einrichten", status: "backlog", ownerMemberId: null });
    mockedApi.activateProject.mockResolvedValue({ ...story, status: "active", ownerMemberId: 2 });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Homeoffice-Ecke einrichten");

    swipe(container, 100);

    // No failure/error — the assignment sheet opens instead.
    expect(await screen.findByRole("heading", { name: "Verantwortliche Person zuweisen" })).toBeInTheDocument();
    expect(screen.getByText("Für die Aktivierung muss zuerst eine verantwortliche Person zugewiesen werden.")).toBeInTheDocument();

    // Activating without a driver is illegal, so no "Niemand zugewiesen" chip
    // is offered here — only the household members.
    const group = screen.getByRole("group", { name: "Verantwortlich" });
    expect(within(group).queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      within(group).queryByRole("button", { name: "Niemand zugewiesen" }),
    ).not.toBeInTheDocument();
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mira", "Noah"]);

    await userEvent.click(within(group).getByRole("button", { name: "Noah" }));
    expect(within(group).getByRole("button", { name: "Noah" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.activateProject).toHaveBeenCalledWith(13, { ownerMemberId: 2 }),
    );
  });

  it("reveals the action-chip strip on a left swipe past the threshold, and via the kebab as a non-gesture alternative", async () => {
    const story = makeProject({ id: 14, title: "Altes Gartenhaus abreißen", status: "backlog" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Altes Gartenhaus abreißen");

    swipe(container, -100);
    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });
    expect(within(chips).getByRole("button", { name: "Verantwortlich" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Erledigt, wenn …" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Planen" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Tags" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Projekt öffnen" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Archivieren" })).toBeInTheDocument();

    // Closing and reopening via the kebab (no swipe gesture at all).
    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    expect(screen.queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    expect(screen.getByRole("group", { name: "Weitere Aktionen" })).toBeInTheDocument();
  });

  it("assigns a driver via the 'Verantwortlich' chip without activating the story", async () => {
    const story = makeProject({ id: 15, title: "Keller aufräumen", status: "backlog", ownerMemberId: null });
    mockedApi.updateProject.mockResolvedValue({ ...story, ownerMemberId: 2 });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Keller aufräumen");

    swipe(container, -100);
    await userEvent.click(screen.getByRole("button", { name: "Verantwortlich" }));

    // Clearing the driver is legal while the story sits in the backlog, so the
    // "Niemand zugewiesen" chip is offered and starts pressed.
    const group = screen.getByRole("group", { name: "Verantwortlich" });
    expect(within(group).getByRole("button", { name: "Niemand zugewiesen" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(within(group).getByRole("button", { name: "Noah" }));
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.updateProject).toHaveBeenCalledWith(15, { ownerMemberId: 2 }));
    expect(mockedApi.activateProject).not.toHaveBeenCalled();
  });

  it("archives a story via the 'Archivieren' chip, retaining it with optimistic styling before it disappears", async () => {
    vi.useFakeTimers();
    const story = makeProject({ id: 16, title: "Winterreifen wechseln", status: "backlog" });
    mockedApi.archiveProject.mockResolvedValue({ ...story, status: "archived" });
    const { container } = renderWithProviders(<Harness story={story} />);
    // Rendered synchronously from the `story` prop (no fetch involved), so a
    // plain sync query works here — `findByText`'s polling relies on real
    // timers and would hang once fake timers are active.
    expect(screen.getByText("Winterreifen wechseln")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    fireEvent.click(screen.getByRole("button", { name: "Archivieren" }));

    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockedApi.archiveProject).toHaveBeenCalledWith(16);
    expect(container.querySelector(".story-row-content.retained")).toBeInTheDocument();
    expect(screen.getByText("Archiviert")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETENTION_MS - 500);
    });
    expect(screen.getByText("Winterreifen wechseln")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // Retention window elapsed: no longer rendered as retained. The row prop
    // itself (`storyProp`) is unchanged in this harness, so it keeps
    // rendering — but no longer with the retained/optimistic styling.
    expect(container.querySelector(".story-row-content.retained")).not.toBeInTheDocument();
  });

  it("shows an inline, dismissible error and does not retain the story when activation fails", async () => {
    const story = makeProject({ id: 17, title: "Fehlerfall Aktivierung", status: "backlog", ownerMemberId: 1 });
    mockedApi.activateProject.mockRejectedValue(new Error("Netzwerkfehler"));
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Fehlerfall Aktivierung");

    swipe(container, 100);
    await screen.findByText("Netzwerkfehler");
    expect(container.querySelector(".story-row-content.retained")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByText("Netzwerkfehler")).not.toBeInTheDocument();
  });

  it("edits acceptance criteria in a targeted popup without leaving the backlog list", async () => {
    const story = makeProject({
      id: 18,
      title: "Speicherplatz aufräumen",
      status: "backlog",
      acceptanceCriteria: [makeCriterion({ id: 90, projectId: 18, text: "Alte Fotos gesichert" })],
    });
    mockedApi.addCriterion.mockResolvedValue(story);
    const { container } = renderAtRootWithProjectRoute(<Harness story={story} />);
    await screen.findByText("Speicherplatz aufräumen");

    swipe(container, -100);
    await userEvent.click(screen.getByRole("button", { name: "Erledigt, wenn …" }));

    // Stays on the backlog list — a focused sheet, not the project page.
    expect(screen.queryByTestId("project-page")).not.toBeInTheDocument();
    expect(await screen.findByDisplayValue("Alte Fotos gesichert")).toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText("Erledigt, wenn …"),
      "Papierkram entsorgt",
    );
    await userEvent.click(screen.getByRole("button", { name: "Punkt hinzufügen" }));

    await waitFor(() => expect(mockedApi.addCriterion).toHaveBeenCalledWith(18, "Papierkram entsorgt"));
    expect(screen.queryByTestId("project-page")).not.toBeInTheDocument();
  });

  it("still navigates to the project detail page through 'Projekt öffnen'", async () => {
    const story = makeProject({ id: 19, title: "Dachboden entrümpeln", status: "backlog" });
    const { container } = renderAtRootWithProjectRoute(<Harness story={story} />);
    await screen.findByText("Dachboden entrümpeln");

    swipe(container, -100);
    await userEvent.click(screen.getByRole("button", { name: "Projekt öffnen" }));
    expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 19");
  });
});
