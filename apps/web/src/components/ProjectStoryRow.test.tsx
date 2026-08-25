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
import { useProjectWorkflowActions } from "../lib/useProjectWorkflowActions";
import { RETENTION_MS } from "../lib/useTaskActions";
import { api } from "../lib/api";
import type { ProjectWithActions } from "../lib/api";
import { makeCriterion, makeMember, makeProject, makeTask } from "../test/fixtures";
import "../styles/index.css";
import "./ProjectStoryRow.css";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
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

function Harness({
  story,
  variant = "card",
}: {
  story: ProjectWithActions;
  variant?: "compact" | "card";
}) {
  const actions = useProjectWorkflowActions();
  return (
    <ul>
      <ProjectStoryRow story={story} actions={actions} variant={variant} />
    </ul>
  );
}

function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".story-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

/** Mirrors `renderWithProviders` but adds a `/projekte/:id` marker route. */
function renderWithProjectRoute(ui: ReactElement) {
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
            <Route path="/projekte/:id" element={<ProjectRouteMarker />} />
          </Routes>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>,
  );
}

function openChips() {
  fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
  return screen.getByRole("group", { name: "Weitere Aktionen" });
}

describe("ProjectStoryRow – status-appropriate primary swipe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), makeMember({ id: 2, name: "Noah" })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("activates a backlog story that already has a driver", async () => {
    const story = makeProject({ id: 20, title: "Kellerregal bauen", status: "backlog", ownerMemberId: 1 });
    mockedApi.activateProject.mockResolvedValue({ ...story, status: "active" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Kellerregal bauen");

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.activateProject).toHaveBeenCalledWith(20, undefined);
    expect(container.querySelector(".story-row-content.retained")).toBeInTheDocument();
    expect(screen.getByText("Aktiviert")).toBeInTheDocument();
  });

  it("completes an active story", async () => {
    const story = makeProject({ id: 21, title: "Urlaub planen", status: "active", ownerMemberId: 1 });
    mockedApi.completeProject.mockResolvedValue({ ...story, status: "completed" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Urlaub planen");

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeProject).toHaveBeenCalledWith(21);
    expect(screen.getByText("Abgeschlossen")).toBeInTheDocument();
  });

  it("reopens a completed story", async () => {
    const story = makeProject({ id: 22, title: "Steuererklärung", status: "completed", ownerMemberId: 1 });
    mockedApi.reopenProject.mockResolvedValue({ ...story, status: "active" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Steuererklärung");

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.reopenProject).toHaveBeenCalledWith(22);
    expect(screen.getByText("Wieder geöffnet")).toBeInTheDocument();
  });

  it("activates an archived story that still has its driver", async () => {
    const story = makeProject({ id: 23, title: "Gartenhaus streichen", status: "archived", ownerMemberId: 2 });
    mockedApi.activateProject.mockResolvedValue({ ...story, status: "active" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Gartenhaus streichen");

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.activateProject).toHaveBeenCalledWith(23, undefined);
    expect(screen.getByText("Aktiviert")).toBeInTheDocument();
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
    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeProject).not.toHaveBeenCalled();
    expect(mockedApi.archiveProject).toHaveBeenCalledWith(24);
  });
});

describe("ProjectStoryRow – missing driver popup on activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), makeMember({ id: 2, name: "Noah" })]);
  });

  it.each<[ProjectStatus, number]>([
    ["backlog", 30],
    ["archived", 31],
  ])("asks for a driver instead of failing when activating a %s story without one", async (status, id) => {
    const story = makeProject({ id, title: `Ohne Driver ${status}`, status, ownerMemberId: null });
    mockedApi.activateProject.mockResolvedValue({ ...story, status: "active", ownerMemberId: 2 });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText(`Ohne Driver ${status}`);

    swipe(container, 100);

    expect(await screen.findByRole("heading", { name: "Verantwortliche Person zuweisen" })).toBeInTheDocument();
    expect(
      screen.getByText("Für die Aktivierung muss zuerst eine verantwortliche Person zugewiesen werden."),
    ).toBeInTheDocument();
    expect(mockedApi.activateProject).not.toHaveBeenCalled();

    const group = screen.getByRole("group", { name: "Verantwortlich" });
    // Activating without a driver is illegal — no "Niemand zugewiesen" chip.
    expect(within(group).queryByRole("button", { name: "Niemand zugewiesen" })).not.toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Noah" }));
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    // Assigning and activating happen in one atomic backend call.
    await waitFor(() => expect(mockedApi.activateProject).toHaveBeenCalledWith(id, { ownerMemberId: 2 }));
    expect(mockedApi.updateProject).not.toHaveBeenCalled();
  });

  it("asks for a driver when activating via the chip of an archived story too", async () => {
    const story = makeProject({
      id: 32,
      title: "Archiv ohne Driver",
      status: "completed",
      ownerMemberId: null,
      availableActions: ["reopen", "activate"],
    });
    renderWithProviders(<Harness story={story} />);
    await screen.findByText("Archiv ohne Driver");

    const chips = openChips();
    await userEvent.click(within(chips).getByRole("button", { name: "Aktivieren" }));

    expect(await screen.findByRole("heading", { name: "Verantwortliche Person zuweisen" })).toBeInTheDocument();
    expect(mockedApi.activateProject).not.toHaveBeenCalled();
  });
});

describe("ProjectStoryRow – left-swipe/kebab chips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" }), makeMember({ id: 2, name: "Noah" })]);
  });

  it("reveals the targeted chips plus the remaining legal transitions of an active story", async () => {
    const story = makeProject({ id: 40, title: "Aktive Geschichte", status: "active", ownerMemberId: 1 });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Aktive Geschichte");

    swipe(container, -100);
    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });
    expect(within(chips).getByRole("button", { name: "Verantwortlich" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Akzeptanzkriterien" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Planen" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Bearbeiten" })).toBeInTheDocument();
    // Secondary workflow actions, derived from `availableActions` — the
    // primary one (Abschließen) is not repeated here.
    expect(within(chips).getByRole("button", { name: "In Backlog zurücklegen" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Archivieren" })).toBeInTheDocument();
    expect(within(chips).queryByRole("button", { name: "Abschließen" })).not.toBeInTheDocument();
  });

  it("offers only the legal secondary transitions for a completed and an archived story", async () => {
    const completed = makeProject({ id: 41, title: "Fertige Geschichte", status: "completed", ownerMemberId: 1 });
    const { unmount } = renderWithProviders(<Harness story={completed} />);
    await screen.findByText("Fertige Geschichte");
    let chips = openChips();
    expect(within(chips).getByRole("button", { name: "Archivieren" })).toBeInTheDocument();
    expect(within(chips).queryByRole("button", { name: "In Backlog zurücklegen" })).not.toBeInTheDocument();
    expect(within(chips).queryByRole("button", { name: "Wieder öffnen" })).not.toBeInTheDocument();
    unmount();

    const archived = makeProject({ id: 42, title: "Archivierte Geschichte", status: "archived", ownerMemberId: 1 });
    renderWithProviders(<Harness story={archived} />);
    await screen.findByText("Archivierte Geschichte");
    chips = openChips();
    expect(within(chips).getByRole("button", { name: "In Backlog zurücklegen" })).toBeInTheDocument();
    expect(within(chips).queryByRole("button", { name: "Archivieren" })).not.toBeInTheDocument();
  });

  it("returns an active story to the backlog from the chip strip", async () => {
    const story = makeProject({ id: 43, title: "Doch nicht jetzt", status: "active", ownerMemberId: 1 });
    mockedApi.returnProjectToBacklog.mockResolvedValue({ ...story, status: "backlog" });
    renderWithProviders(<Harness story={story} />);
    await screen.findByText("Doch nicht jetzt");

    const chips = openChips();
    fireEvent.click(within(chips).getByRole("button", { name: "In Backlog zurücklegen" }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.returnProjectToBacklog).toHaveBeenCalledWith(43);
    expect(screen.getByText("Zurück im Backlog")).toBeInTheDocument();
  });

  it("respects the driver invariant: an active story's driver can be reassigned but not cleared", async () => {
    const story = makeProject({ id: 44, title: "Driver-Regel", status: "active", ownerMemberId: 1 });
    mockedApi.updateProject.mockResolvedValue({ ...story, ownerMemberId: 2 });
    renderWithProviders(<Harness story={story} />);
    await screen.findByText("Driver-Regel");

    const chips = openChips();
    await userEvent.click(within(chips).getByRole("button", { name: "Verantwortlich" }));

    const group = screen.getByRole("group", { name: "Verantwortlich" });
    expect(within(group).queryByRole("button", { name: "Niemand zugewiesen" })).not.toBeInTheDocument();
    expect(
      screen.getByText("Die verantwortliche Person kann erst entfernt werden, wenn die Geschichte wieder im Backlog liegt."),
    ).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Noah" }));
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.updateProject).toHaveBeenCalledWith(44, { ownerMemberId: 2 }));
    // A driver change must never move the story through the workflow.
    expect(mockedApi.activateProject).not.toHaveBeenCalled();
    expect(mockedApi.completeProject).not.toHaveBeenCalled();
  });

  it("still allows clearing the driver of a backlog story", async () => {
    const story = makeProject({ id: 45, title: "Backlog-Driver", status: "backlog", ownerMemberId: 1 });
    renderWithProviders(<Harness story={story} variant="compact" />);
    await screen.findByText("Backlog-Driver");

    const chips = openChips();
    await userEvent.click(within(chips).getByRole("button", { name: "Verantwortlich" }));

    const group = screen.getByRole("group", { name: "Verantwortlich" });
    expect(within(group).getByRole("button", { name: "Niemand zugewiesen" })).toBeInTheDocument();
    expect(
      screen.queryByText("Die verantwortliche Person kann erst entfernt werden, wenn die Geschichte wieder im Backlog liegt."),
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
    await userEvent.click(within(chips).getByRole("button", { name: "Akzeptanzkriterien" }));
    expect(screen.queryByTestId("project-page")).not.toBeInTheDocument();
    expect(await screen.findByDisplayValue("Angebot eingeholt")).toBeInTheDocument();
    // The sheet header's ✕ and the criteria sheet's own footer button share
    // the "Schließen" label — the header one is the `icon-btn`.
    await userEvent.click(
      screen.getAllByRole("button", { name: "Schließen" }).find((b) => b.classList.contains("icon-btn"))!,
    );

    chips = openChips();
    await userEvent.click(within(chips).getByRole("button", { name: "Planen" }));
    expect(await screen.findByRole("heading", { name: "Termine planen" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Fällig"), { target: { value: "2026-05-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateProject).toHaveBeenCalledWith(46, { dueDate: "2026-05-01", scheduledDate: null }),
    );
    expect(screen.queryByTestId("project-page")).not.toBeInTheDocument();
  });

  it("navigates to the project page for the full 'Bearbeiten' editor only", async () => {
    const story = makeProject({ id: 47, title: "Voll bearbeiten", status: "active", ownerMemberId: 1 });
    renderWithProjectRoute(<Harness story={story} />);
    await screen.findByText("Voll bearbeiten");

    const chips = openChips();
    await userEvent.click(within(chips).getByRole("button", { name: "Bearbeiten" }));
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
    ["backlog", "Backlog", "Aktivieren"],
    ["active", "Aktiv", "Abschließen"],
    ["completed", "Abgeschlossen", "Wieder öffnen"],
    ["archived", "Archiviert", "Aktivieren"],
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
    // chip strip open.
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

    // … and every status change is an explicitly named button.
    for (const label of ["Abschließen", "In Backlog zurücklegen", "Archivieren"]) {
      expect(screen.getByRole("button", { name: label })).toBeEnabled();
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

    expect(mockedApi.completeProject).toHaveBeenCalledWith(51);
  });

  it("keeps tap-to-detail as a real link, but a swipe never navigates", async () => {
    const story = makeProject({ id: 52, title: "Tippen öffnet Detail", status: "active", ownerMemberId: 1 });
    mockedApi.completeProject.mockResolvedValue({ ...story, status: "completed" });
    const { container } = renderWithProjectRoute(<Harness story={story} />);
    await screen.findByText("Tippen öffnet Detail");

    const link = container.querySelector(".story-row-main") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("/projekte/52");

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

  it("shows criteria and task progress on the card variant, and no free-text description", async () => {
    const story = makeProject({
      id: 53,
      title: "Umzug organisieren",
      status: "active",
      ownerMemberId: 1,
      openCount: 2,
      doneCount: 2,
      nextAction: makeTask({ id: 500, title: "Kartons kaufen" }),
      acceptanceCriteria: [
        makeCriterion({ checked: true }),
        makeCriterion({ checked: false }),
        makeCriterion({ checked: false }),
      ],
    });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Umzug organisieren");

    expect(screen.getByText("Akzeptanzkriterien: 1/3")).toBeInTheDocument();
    expect(screen.getByText("Aufgaben: 2/4")).toBeInTheDocument();
    expect(screen.getByText("Nächster Schritt: Kartons kaufen")).toBeInTheDocument();
    expect(screen.getByText("Mira")).toBeInTheDocument();
    // Only the task-completion bar remains — the second, unlabelled
    // acceptance-criteria bar was removed from list/card rows (the criteria
    // *count* above is retained; the bar itself still lives in the
    // detail/editor screens, unaffected by this component).
    expect(container.querySelector(".project-card-progress")).toBeInTheDocument();
    expect(container.querySelector(".criteria-progress")).not.toBeInTheDocument();
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  });

  it("omits the progress bar when there is nothing to show", async () => {
    const story = makeProject({ id: 54, title: "Ohne Kriterien", status: "backlog", acceptanceCriteria: [] });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Ohne Kriterien");

    expect(container.querySelector(".criteria-progress")).not.toBeInTheDocument();
    expect(container.querySelector(".project-card-progress")).not.toBeInTheDocument();
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    expect(screen.getByText("Kein nächster Schritt")).toBeInTheDocument();
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
    const story = makeProject({ id: 61, title: "Zyklus", status: "active", ownerMemberId: 1 });
    mockedApi.completeProject.mockResolvedValue({
      ...story,
      status: "completed",
      availableActions: ["reopen", "archive"],
    });
    mockedApi.reopenProject.mockResolvedValue({ ...story, status: "active" });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Zyklus");

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockedApi.completeProject).toHaveBeenCalledWith(61);

    // The retained row already advertises the *next* step of the cycle.
    await waitFor(() =>
      expect(container.querySelector(".story-row-primary")).toHaveAttribute("aria-label", "Wieder öffnen"),
    );

    swipe(container, 100);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.reopenProject).toHaveBeenCalledWith(61);
    expect(screen.getByText("Wieder geöffnet")).toBeInTheDocument();
  });

  it("rolls the row back and shows a dismissible inline error when the transition fails", async () => {
    const story = makeProject({ id: 62, title: "Fehlerfall", status: "active", ownerMemberId: 1 });
    mockedApi.completeProject.mockRejectedValue(new Error("Netzwerkfehler"));
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText("Fehlerfall");

    swipe(container, 100);
    await screen.findByText("Netzwerkfehler");

    // No retained optimistic state, and the row is back to its real status.
    expect(container.querySelector(".story-row-content.retained")).not.toBeInTheDocument();
    expect(container.querySelector(".story-row-status-badge")).toHaveTextContent("Aktiv");
    expect(container.querySelector(".story-row-primary")).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByText("Netzwerkfehler")).not.toBeInTheDocument();
  });
});

describe("ProjectStoryRow – compact icon-only targeted actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it("renders Verantwortlich/Akzeptanzkriterien/Planen/Bearbeiten as icon-only 44px buttons with a full German accessible name", async () => {
    const story = makeProject({ id: 70, title: "Kompakte Chips", status: "active", ownerMemberId: 1 });
    renderWithProviders(<Harness story={story} />);
    await screen.findByText("Kompakte Chips");

    const chips = openChips();
    const targeted = [
      { name: "Verantwortlich" },
      { name: "Akzeptanzkriterien" },
      { name: "Planen" },
      { name: "Bearbeiten" },
    ];
    for (const { name } of targeted) {
      const button = within(chips).getByRole("button", { name });
      // Icon-only: no visible text label, only the accessible name/tooltip.
      expect(button).toHaveClass("story-row-chip-icon");
      expect(button.textContent).toBe("");
      expect(button).toHaveAttribute("aria-label", name);
      expect(button).toHaveAttribute("title", name);

      // A single decorative, non-focusable SVG glyph that never itself gets
      // announced (the button already carries the full label).
      const svg = button.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("focusable", "false");

      // 44px meets the coarse-pointer touch-target size everywhere, not just
      // behind a `(pointer: coarse)` media query.
      const style = getComputedStyle(button);
      expect(style.width).toBe("44px");
      expect(style.height).toBe("44px");
    }

    // The workflow-transition chips stay plain, labelled text buttons.
    const workflowChip = within(chips).getByRole("button", { name: "Archivieren" });
    expect(workflowChip).not.toHaveClass("story-row-chip-icon");
    expect(workflowChip.textContent).toBe("Archivieren");
  });
});

describe("ProjectStoryRow – semantic status accents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it.each<[ProjectStatus, string]>([
    ["backlog", "backlog"],
    ["active", "active"],
    ["completed", "completed"],
    ["archived", "archived"],
  ])("gives a %s story its own distinct accent classes (not the same as any other status)", async (status, accent) => {
    const story = makeProject({ id: 80, title: `Akzent ${status}`, status, ownerMemberId: 1 });
    const { container } = renderWithProviders(<Harness story={story} />);
    await screen.findByText(`Akzent ${status}`);

    expect(container.querySelector(".story-row")).toHaveClass(`story-row-accent-${accent}`);
    expect(container.querySelector(".story-row-status-badge")).toHaveClass(`story-row-status-badge--${accent}`);
    expect(container.querySelector(".story-row-primary")).toHaveClass(`story-row-primary--${accent}`);
  });

  it("gives an active story a healthy green accent, distinct from an active-but-stuck one", async () => {
    const healthy = makeProject({ id: 81, title: "Gesund aktiv", status: "active", ownerMemberId: 1 });
    const { container: healthyContainer, unmount } = renderWithProviders(<Harness story={healthy} />);
    await screen.findByText("Gesund aktiv");
    expect(healthyContainer.querySelector(".story-row")).toHaveClass("story-row-accent-active");
    expect(healthyContainer.querySelector(".story-row")).not.toHaveClass("story-row-accent-stuck");
    unmount();

    const stuck = makeProject({
      id: 82,
      title: "Festgefahren aktiv",
      status: "active",
      ownerMemberId: 1,
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
  });

  it("never gives the backlog accent the same green used for a healthy active story", async () => {
    const backlog = makeProject({ id: 83, title: "Neu im Backlog", status: "backlog" });
    const { container } = renderWithProviders(<Harness story={backlog} />);
    await screen.findByText("Neu im Backlog");

    const badge = container.querySelector(".story-row-status-badge") as HTMLElement;
    expect(badge).toHaveClass("story-row-status-badge--backlog");
    expect(getComputedStyle(badge).color).not.toBe(getComputedStyle(document.createElement("div")).color);
    // The backlog badge must not reuse the exact green tone reserved for an
    // active/healthy story.
    const activeProbe = makeProject({ id: 84, title: "Aktiv-Probe", status: "active", ownerMemberId: 1 });
    const { container: activeContainer } = renderWithProviders(<Harness story={activeProbe} />);
    await screen.findByText("Aktiv-Probe");
    const activeBadge = activeContainer.querySelector(".story-row-status-badge") as HTMLElement;
    expect(getComputedStyle(badge).color).not.toBe(getComputedStyle(activeBadge).color);
  });
});
