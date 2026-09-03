import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { api } from "../lib/api";
import { makeMember, makeTag, makeTask } from "../test/fixtures";
import { resolveScheduleShortcut } from "./ScheduleShortcuts";
import { SWIPE_COACH_STORAGE_KEY } from "../lib/swipeCoach";
import { useTaskDetail } from "../lib/taskDetailContext";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    clarifyTask: vi.fn(),
    updateTask: vi.fn(),
    createTaskSuccessor: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);
const STORAGE_KEY = "machbar:primary-swipe-action";
const IDENTITY_STORAGE_KEY = "machbar:identity-member-id";

function mockPointer(coarse: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(pointer: coarse)" && coarse,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

/** Simulates a horizontal drag past the swipe threshold and releases it. */
function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".task-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

function OpenTaskProbe() {
  const { openTaskId } = useTaskDetail();
  return <span data-testid="open-task">{openTaskId ?? "none"}</span>;
}

describe("TaskRow – one-time swipe coach", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockPointer(true);
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("previews only one row and cancels without acting when the row is touched", async () => {
    const { container } = renderWithProviders(
      <TaskOutline
        tasks={[
          makeTask({ id: 201, title: "Erste Aufgabe" }),
          makeTask({ id: 202, title: "Zweite Aufgabe" }),
        ]}
        emptyMessage="Nichts da"
      />,
    );

    const hint = await screen.findByText(/Wischen: rechts „Erledigt“, links mehr/);
    expect(screen.getAllByText(/Wischen: rechts/)).toHaveLength(1);
    expect(container.querySelectorAll(".swipe-coach-preview")).toHaveLength(1);

    const coachedRow = hint.closest(".task-row")!;
    const content = coachedRow.querySelector(".task-row-content")!;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });

    await waitFor(() => expect(hint).not.toBeInTheDocument());
    expect(window.localStorage.getItem(SWIPE_COACH_STORAGE_KEY)).toBe("seen");
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("does not mark the touch lesson seen when a mouse clicks on a hybrid device", async () => {
    const { container } = renderWithProviders(
      <TaskOutline
        tasks={[makeTask({ id: 203, title: "Desktop-Aufgabe" })]}
        emptyMessage="Nichts da"
      />,
    );
    await screen.findByText("Desktop-Aufgabe");
    await screen.findByText(/Wischen: rechts/);

    fireEvent.pointerDown(container.querySelector(".task-row-content")!, {
      clientX: 0,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(window.localStorage.getItem(SWIPE_COACH_STORAGE_KEY)).toBeNull();
  });
});

describe("TaskRow – primary swipe direction mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
    mockedApi.completeTask.mockResolvedValue(makeTask());
    mockedApi.cancelTask.mockResolvedValue(makeTask());
    mockedApi.reopenTask.mockResolvedValue(makeTask());
    mockedApi.clarifyTask.mockResolvedValue(makeTask());
    mockedApi.updateTask.mockResolvedValue(makeTask());
  });

  it("swipes right into the default configured action (erledigen) for an open task", async () => {
    const task = makeTask({ id: 1, title: "Rechnung bezahlen", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Rechnung bezahlen");

    swipe(container, 100);

    await waitFor(() =>
      expect(mockedApi.completeTask).toHaveBeenCalledWith(
        1,
        "leave_open",
        undefined,
        1,
      ),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("suppresses the click after a real swipe, then lets the next tap open details", async () => {
    const task = makeTask({ id: 16, title: "Wischen statt öffnen", status: "actionable" });
    const { container } = renderWithProviders(
      <>
        <TaskOutline tasks={[task]} emptyMessage="Nichts da" />
        <OpenTaskProbe />
      </>,
    );
    await screen.findByText("Wischen statt öffnen");
    const content = container.querySelector(".task-row-content") as HTMLElement;
    const main = container.querySelector(".task-row-main") as HTMLElement;

    swipe(container, -100);
    fireEvent.click(main);
    expect(screen.getByTestId("open-task")).toHaveTextContent("none");

    fireEvent.pointerDown(content, { clientX: 20, pointerId: 2 });
    fireEvent.pointerUp(content, { clientX: 20, pointerId: 2 });
    fireEvent.click(main);
    expect(screen.getByTestId("open-task")).toHaveTextContent("16");
  });

  it("cancels an in-progress swipe without running either action", async () => {
    const task = makeTask({ id: 17, title: "Abgebrochene Geste", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Abgebrochene Geste");
    const content = container.querySelector(".task-row-content") as HTMLElement;

    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(content, { clientX: 100, pointerId: 1 });
    fireEvent.pointerCancel(content, { pointerId: 1 });

    expect(content.style.transform).toBe("");
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(mockedApi.cancelTask).not.toHaveBeenCalled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("clarifies a captured task before it can be completed", async () => {
    const task = makeTask({
      id: 13,
      title: "Nächsten Schritt klären",
      status: "actionable",
      needsClarification: true,
    });
    mockedApi.clarifyTask.mockResolvedValue({
      ...task,
      revision: 2,
      needsClarification: false,
    });
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );
    await screen.findByText("Nächsten Schritt klären");

    expect(container.querySelector(".task-row-state-captured")).toHaveTextContent("Erfasst");
    swipe(container, 100);

    await waitFor(() =>
      expect(mockedApi.clarifyTask).toHaveBeenCalledWith(13, 1),
    );
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
  });

  it("announces Machbar while a captured task is swiped right", async () => {
    const task = makeTask({
      id: 14,
      title: "Ungeklärte Aufgabe",
      status: "actionable",
      needsClarification: true,
    });
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );
    await screen.findByText("Ungeklärte Aufgabe");

    const content = container.querySelector(".task-row-content") as HTMLElement;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(content, { clientX: 70, pointerId: 1 });

    expect(container.querySelector(".task-row-swipe-bg.complete")).toHaveTextContent("Machbar");
  });

  it("clarifies a captured task before a configured defer action outside Eingang", async () => {
    window.localStorage.setItem(STORAGE_KEY, "someday");
    const task = makeTask({
      id: 15,
      title: "Später einordnen",
      status: "actionable",
      needsClarification: true,
    });
    mockedApi.clarifyTask.mockResolvedValue({
      ...task,
      revision: 2,
      needsClarification: false,
    });
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );
    await screen.findByText("Später einordnen");

    swipe(container, 100);

    await waitFor(() =>
      expect(mockedApi.clarifyTask).toHaveBeenCalledWith(15, 1),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalledWith(
      15,
      expect.objectContaining({ status: "someday" }),
    );
  });

  it("can swipe the retained crossed-out row again to reopen it", async () => {
    const task = makeTask({ id: 9, title: "Status direkt wechseln", status: "actionable" });
    const completed = makeTask({ ...task, status: "done" });
    mockedApi.completeTask.mockResolvedValue(completed);
    mockedApi.reopenTask.mockResolvedValue(task);
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );
    await screen.findByText("Status direkt wechseln");

    swipe(container, 100);
    await waitFor(() =>
      expect(mockedApi.completeTask).toHaveBeenCalledWith(
        9,
        "leave_open",
        undefined,
        1,
      ),
    );
    expect(container.querySelector(".task-row-content.retained")).toBeInTheDocument();

    swipe(container, 100);
    await waitFor(() =>
      expect(mockedApi.reopenTask).toHaveBeenCalledWith(9, 1),
    );
  });

  it("respects a configured 'Irgendwann' primary swipe action on an open task", async () => {
    window.localStorage.setItem(STORAGE_KEY, "someday");
    const task = makeTask({ id: 3, title: "Bücher sortieren", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Bücher sortieren");

    swipe(container, 100);

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(3, {
      status: "someday",
      expectedRevision: 1,
    }));
  });

  it("renders phone numbers and email addresses in notes as actionable links", async () => {
    const task = makeTask({
      id: 12,
      title: "Sekretariat kontaktieren",
      notes: "Tel. 072194390-387 oder schule@example.de",
    });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);

    expect(await screen.findByRole("link", { name: "072194390-387" })).toHaveAttribute(
      "href",
      "tel:072194390-387",
    );
    expect(screen.getByRole("link", { name: "schule@example.de" })).toHaveAttribute(
      "href",
      "mailto:schule@example.de",
    );
  });

  it("respects a configured 'Verwerfen' primary swipe action on an open task", async () => {
    window.localStorage.setItem(STORAGE_KEY, "cancel");
    const task = makeTask({ id: 4, title: "Altes Angebot", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Altes Angebot");

    swipe(container, 100);

    await waitFor(() =>
      expect(mockedApi.cancelTask).toHaveBeenCalledWith(4, "leave_open", 1),
    );
  });

  it.each(["someday", "cancel", "complete"] as const)(
    "always reopens an already done task via the primary swipe, regardless of the '%s' setting",
    async (configured) => {
      window.localStorage.setItem(STORAGE_KEY, configured);
      const task = makeTask({ id: 5, title: "Erledigte Aufgabe", status: "done" });
      const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
      await screen.findByText("Erledigte Aufgabe");

      swipe(container, 100);

      await waitFor(() =>
        expect(mockedApi.reopenTask).toHaveBeenCalledWith(5, 1),
      );
      expect(mockedApi.updateTask).not.toHaveBeenCalled();
      expect(mockedApi.cancelTask).not.toHaveBeenCalled();
    },
  );

  it("always reopens an already cancelled task via the primary swipe", async () => {
    window.localStorage.setItem(STORAGE_KEY, "someday");
    const task = makeTask({ id: 6, title: "Verworfene Aufgabe", status: "cancelled" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Verworfene Aufgabe");

    swipe(container, 100);

    await waitFor(() =>
      expect(mockedApi.reopenTask).toHaveBeenCalledWith(6, 1),
    );
  });

  it("reveals the touch-chip row (not an action) on the opposite swipe direction", async () => {
    const task = makeTask({ id: 7, title: "Projektplan", status: "actionable" });
    const { container } = renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Projektplan");

    swipe(container, -100);

    expect(screen.getByRole("button", { name: "Zuweisen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Planen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notizen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mehr" })).toBeInTheDocument();
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(mockedApi.cancelTask).not.toHaveBeenCalled();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("also reveals the chip row via the explicit ⋯ button (non-gesture access)", async () => {
    const task = makeTask({ id: 8, title: "Steuerunterlagen", status: "actionable" });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Steuerunterlagen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));

    expect(screen.getByRole("button", { name: "Zuweisen" })).toBeInTheDocument();
  });

  it("renders task actions as compact SVG buttons rather than visible text", async () => {
    const task = makeTask({ id: 10, title: "Kompakte Aktionen", status: "actionable", projectId: 2 });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Kompakte Aktionen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));

    for (const name of [
      "Zuweisen",
      "Planen",
      "Notizen",
      "Teilaufgabe hinzufügen",
      "Nächsten Schritt danach hinzufügen",
      "Zum Projekt",
      "Mehr",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass("icon-action-button");
      expect(button.textContent).toBe("");
      const glyph = button.querySelector("svg");
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      expect(glyph).toHaveAttribute("focusable", "false");
    }
  });

  it("adds a successor from the chip row and returns focus to the task", async () => {
    const task = makeTask({
      id: 11,
      title: "Angebot einholen",
      status: "actionable",
      projectId: 2,
    });
    mockedApi.createTaskSuccessor.mockResolvedValue(
      makeTask({ id: 12, title: "Termin vereinbaren", projectId: 2 }),
    );
    renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );
    await screen.findByText("Angebot einholen");

    const moreButton = screen.getByRole("button", {
      name: "Weitere Aktionen",
    });
    await userEvent.click(moreButton);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Nächsten Schritt danach hinzufügen",
      }),
    );
    await userEvent.type(
      screen.getByPlaceholderText("Nächster Schritt"),
      "Termin vereinbaren",
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTaskSuccessor).toHaveBeenCalledWith(
        11,
        expect.objectContaining({ title: "Termin vereinbaren" }),
      ),
    );
    expect(moreButton).toHaveFocus();
  });
});

describe("TaskRow – calm shared card presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
      makeMember({ id: 2, name: "Alex" }),
    ]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
  });

  it("uses the title/tag header and omits the routine actionable label", async () => {
    const task = makeTask({
      id: 20,
      title: "Ruhige Aufgabenkarte",
      status: "actionable",
      effectiveTags: [
        makeTag({ id: 1, name: "Anna", kind: "actor" }),
        makeTag({ id: 2, name: "Telefon", kind: "plain" }),
        makeTag({ id: 3, name: "Garten", kind: "area" }),
        makeTag({ id: 4, name: "Draußen", kind: "plain" }),
      ],
    });
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );
    await screen.findByText("Ruhige Aufgabenkarte");

    expect(container.querySelector(".task-row")).toHaveClass("task-row-surface-actionable");
    const header = container.querySelector(".task-row-header");
    expect(header).toContainElement(
      screen.getByText("Ruhige Aufgabenkarte"),
    );
    expect(header?.firstElementChild).toHaveClass("task-card-tags");
    expect(container.querySelector(".task-row-main")).toHaveAttribute(
      "aria-label",
      "Ruhige Aufgabenkarte",
    );
    expect(screen.queryByText("Machbar")).not.toBeInTheDocument();

    const tags = screen.getByRole("list", { name: "Tags" });
    expect(within(tags).getByText("Garten")).toBeInTheDocument();
    expect(within(tags).getByText("Draußen")).toBeInTheDocument();
    expect(within(tags).getByLabelText("1 weitere Tags")).toHaveTextContent("+1");
    expect(within(tags).queryByText("Anna")).not.toBeInTheDocument();
    expect(within(tags).queryByText("Telefon")).not.toBeInTheDocument();
  });

  it.each([
    ["someday", "Irgendwann"],
    ["done", "Erledigt"],
    ["cancelled", "Verworfen"],
  ] as const)("keeps the exceptional %s status as quiet metadata", async (status, label) => {
    const task = makeTask({ id: 21, title: `Status ${status}`, status });
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );

    expect(await screen.findByText(label)).toHaveClass("task-row-state");
    expect(container.querySelector(".task-row")).toHaveClass(`task-row-surface-${status}`);
  });

  it("shows assigned owners as labeled lower-right avatars without owner text", async () => {
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, "1");
    const tasks = [
      makeTask({ id: 22, title: "Meine Aufgabe", effectiveOwnerId: 1 }),
      makeTask({ id: 23, title: "Andere Aufgabe", effectiveOwnerId: 2 }),
      makeTask({ id: 24, title: "Gemeinsame Aufgabe", effectiveOwnerId: null }),
    ];
    renderWithProviders(<TaskOutline tasks={tasks} emptyMessage="Nichts da" />);

    expect(await screen.findByLabelText("Zuständig: Ich")).toBeInTheDocument();
    expect(screen.getByLabelText("Zuständig: Alex")).toBeInTheDocument();
    expect(screen.queryByText("Ich")).not.toBeInTheDocument();
    expect(screen.queryByText("Alex")).not.toBeInTheDocument();
    expect(screen.queryByText("Gemeinsam")).not.toBeInTheDocument();
  });

  it("keeps notes in a tertiary region below the header and metadata", async () => {
    const task = makeTask({
      id: 25,
      title: "Mit Notiz",
      notes: "Ruhige Zusatzinformation",
    });
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );
    await screen.findByText("Mit Notiz");

    const wrap = container.querySelector(".task-row-main-wrap");
    expect(wrap?.querySelector(".task-row-header")).toBeInTheDocument();
    expect(wrap?.querySelector(".task-row-meta")).toBeInTheDocument();
    expect(wrap?.querySelector(".task-row-notes")).toHaveTextContent(
      "Ruhige Zusatzinformation",
    );
  });

  it("keeps a long wrapping title complete while tags occupy the upper-right", async () => {
    const title =
      "Sehr lange Aufgabe, die über mehrere Zeilen läuft und unter den Tags wieder die volle Kartenbreite nutzt";
    const task = makeTask({
      id: 26,
      title,
      effectiveTags: [
        makeTag({ id: 31, name: "Haushalt", kind: "area" }),
        makeTag({ id: 32, name: "Unterwegs", kind: "plain" }),
      ],
    });
    const { container } = renderWithProviders(
      <TaskOutline tasks={[task]} emptyMessage="Nichts da" />,
    );

    const titleElement = await screen.findByText(title);
    const header = container.querySelector(".task-row-header");
    expect(titleElement).toHaveClass("task-row-title");
    expect(header?.firstElementChild).toHaveClass("task-card-tags");
    expect(container.querySelector(".task-row-main")).toHaveAttribute(
      "aria-label",
      title,
    );
  });
});

describe("TaskRow – action chips use focused quick-edit flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getTags.mockResolvedValue([makeTag({ id: 20 })]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
  });

  function renderOutlineWithDetail(task: ReturnType<typeof makeTask>) {
    mockedApi.getTask.mockResolvedValue(task);
    return renderWithProviders(
      <div>
        <TaskOutline tasks={[task]} emptyMessage="Nichts da" />
        <TaskDetailSheet />
      </div>,
    );
  }

  it("assigns from a focused sheet and returns without opening full details", async () => {
    const task = makeTask({ id: 30, title: "Kunde anrufen", status: "actionable" });
    renderOutlineWithDetail(task);
    await screen.findByText("Kunde anrufen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Zuweisen" }));

    const group = await screen.findByRole("group", { name: "Zuständig" });
    expect(group.closest(".sheet-backdrop")?.parentElement).toBe(document.body);
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    // Tap chips rather than a native <select>, with the shared/unassigned
    // bucket offered explicitly and pressed while nobody is assigned.
    expect(within(group).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Gemeinsam / offen" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(within(group).getByRole("button", { name: "Mira" }));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(30, {
        ownerMemberId: 1,
        ownerInheritanceMode: "explicit",
        expectedRevision: 1,
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can make an inherited effective owner explicit without changing the person", async () => {
    const task = makeTask({
      id: 35,
      title: "Geerbte Zuständigkeit",
      status: "actionable",
      ownerMemberId: null,
      effectiveOwnerId: 1,
      effectiveOwnerSource: "project",
    });
    renderOutlineWithDetail(task);
    await screen.findByText("Geerbte Zuständigkeit");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Zuweisen" }));
    await userEvent.click(
      within(await screen.findByRole("group", { name: "Zuständig" })).getByRole(
        "button",
        { name: "Mira" },
      ),
    );

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(35, {
        ownerMemberId: 1,
        ownerInheritanceMode: "explicit",
        expectedRevision: 1,
      }),
    );
  });

  it("saves a valid focused schedule immediately and closes", async () => {
    const task = makeTask({ id: 31, title: "Termin vereinbaren", status: "actionable" });
    renderOutlineWithDetail(task);
    await screen.findByText("Termin vereinbaren");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Planen" }));

    await screen.findByLabelText("Geplant");
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(31, {
        scheduledDate: resolveScheduleShortcut("tomorrow"),
        expectedRevision: 1,
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("edits notes from a focused sheet", async () => {
    const task = makeTask({ id: 32, title: "Vertrag prüfen", status: "actionable" });
    renderOutlineWithDetail(task);
    await screen.findByText("Vertrag prüfen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Notizen" }));

    const notes = await screen.findByLabelText("Notizen");
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    await userEvent.type(notes, "Rückfrage vorbereiten");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(32, {
        notes: "Rückfrage vorbereiten",
        expectedRevision: 1,
      }),
    );
  });

  it("opens the full task detail sheet from the 'Mehr' chip", async () => {
    const task = makeTask({ id: 33, title: "Umzug planen", status: "actionable" });
    renderOutlineWithDetail(task);
    await screen.findByText("Umzug planen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Mehr" }));

    expect(
      await screen.findByText("Umzug planen", { selector: "strong" }),
    ).toBeInTheDocument();
  });

});
