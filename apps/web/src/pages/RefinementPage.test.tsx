import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import type { RefinementIssue } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { de as strings } from "../i18n/de";
import type { OwnerSizeCounts, RefinementTaskRow } from "../lib/api";
import { REFINEMENT_RETENTION_MS } from "../lib/useRefinementActions";
import { makeProject, makeTag, makeTask } from "../test/fixtures";
import { RefinementPage } from "./RefinementPage";
import { useTaskDetail } from "../lib/taskDetailContext";
import "../styles/index.css";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn(),
    getRefinementOwners: vi.fn(),
    getRefinementTasks: vi.fn(),
    getRefinementIssues: vi.fn(),
    getProject: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function ownerRow(overrides: Partial<OwnerSizeCounts> = {}): OwnerSizeCounts {
  return { ownerId: 1, ownerName: "Mira", S: 0, M: 0, L: 0, XL: 0, unestimated: 0, total: 0, ...overrides };
}

function taskRow(overrides: Partial<RefinementTaskRow> = {}): RefinementTaskRow {
  return {
    id: 1,
    title: "Beispielaufgabe",
    status: "actionable",
    size: null,
    projectId: null,
    projectTitle: null,
    effectiveOwnerId: null,
    effectiveOwnerSource: "none",
    position: 0,
    updatedAt: "2026-01-01T09:00:00.000Z",
    blocked: false,
    executable: true,
    externalWait: null,
    nextBlockerAttentionDate: null,
    blockers: [],
    dependencies: [],
    effectiveTags: [],
    ...overrides,
    revision: overrides.revision ?? 1,
  };
}

function issue(
  actionCode: RefinementIssue["suggestedAction"]["code"],
  entityType: RefinementIssue["entityType"] = "task",
): RefinementIssue {
  return {
    code: entityType === "project" ? "missing_outcome" : "needs_clarification",
    severity: "warning",
    suggestedAction: {
      code: actionCode,
    },
    entityType,
    entityId: 41,
    entityTitle: "Testobjekt",
    projectId: entityType === "project" ? 41 : null,
    projectTitle: entityType === "project" ? "Testprojekt" : null,
  };
}

function RepairState() {
  const location = useLocation();
  const taskDetail = useTaskDetail();
  return (
    <>
      <output aria-label="repair-state">
        {location.pathname}
        {location.search}|{taskDetail.openTaskId ?? "none"}|
        {taskDetail.focusField ?? "none"}|{String(taskDetail.queueActive)}
      </output>
      <button type="button" onClick={taskDetail.close}>
        Close task repair
      </button>
    </>
  );
}

async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe("RefinementPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.searchTasks.mockResolvedValue([]);
    mockedApi.getRefinementOwners.mockResolvedValue([]);
    mockedApi.getRefinementTasks.mockResolvedValue([]);
    mockedApi.getRefinementIssues.mockResolvedValue({ issues: [], projects: [] });
    mockedApi.getProject.mockImplementation(async (id) => ({
      ...makeProject({ id, title: "Testprojekt" }),
      tasks: [
        makeTask({
          id: 73,
          projectId: id,
          title: "Projektaufgabe",
          dueDate: null,
          scheduledDate: null,
        }),
      ],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the owner x size matrix including the shared/unassigned ('Gemeinsam / offen') bucket, and the open task list with story/owner/size", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([
      ownerRow({ ownerId: 1, ownerName: "Mira", M: 1, total: 1 }),
      ownerRow({ ownerId: null, ownerName: null, S: 1, total: 1 }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({
        id: 101,
        title: "Angebot einholen",
        size: "M",
        projectId: 5,
        projectTitle: "Hausumbau",
        effectiveOwnerId: 1,
        effectiveOwnerSource: "task",
      }),
      taskRow({ id: 102, title: "Rasen mähen", size: "S", effectiveOwnerId: null }),
    ]);

    renderWithProviders(<RefinementPage />);

    await screen.findByText("Angebot einholen");
    expect(
      screen.getByRole("heading", { name: "Arbeit klären" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Aufwand überblicken"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mira" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gemeinsam / offen" })).toBeInTheDocument();
    expect(screen.getByText(/Hausumbau/)).toBeInTheDocument();
    expect(screen.getByText("Rasen mähen")).toBeInTheDocument();
  });

  it("uses self-contained blocker context from refinement rows", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([ownerRow({ ownerId: null, ownerName: null })]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({
        id: 201,
        title: "Handwerker anrufen",
        effectiveOwnerId: null,
        externalWait: { waitingFor: "Rückruf vom Handwerker" },
        blocked: true,
        executable: false,
      }),
    ]);

    renderWithProviders(<RefinementPage />);

    await screen.findByText("Handwerker anrufen");
    expect(screen.getByText(/Rückruf vom Handwerker/)).toBeInTheDocument();
    expect(screen.getByLabelText("Blockiert durch")).toBeInTheDocument();
  });

  it("filters the task list by clicking a matrix cell, and resets via the reset button", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([
      ownerRow({ ownerId: 1, ownerName: "Mira", M: 1, total: 1 }),
      ownerRow({ ownerId: null, ownerName: null, S: 1, total: 1 }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 301, title: "Mira-Aufgabe", size: "M", effectiveOwnerId: 1 }),
      taskRow({ id: 302, title: "Geteilte Aufgabe", size: "S", effectiveOwnerId: null }),
    ]);

    renderWithProviders(<RefinementPage />);
    await screen.findByText("Mira-Aufgabe");
    expect(screen.getByText("Geteilte Aufgabe")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mira" }));

    expect(screen.getByText("Mira-Aufgabe")).toBeInTheDocument();
    expect(screen.queryByText("Geteilte Aufgabe")).not.toBeInTheDocument();
    expect(screen.getByText(/Gefiltert nach/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(screen.getByText("Geteilte Aufgabe")).toBeInTheDocument();
  });

  it("shows the empty state when no open task matches the current filter", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([ownerRow({ ownerId: 1, ownerName: "Mira" })]);
    mockedApi.getRefinementTasks.mockResolvedValue([]);

    renderWithProviders(<RefinementPage />);
    expect(await screen.findByText("Keine offenen Aufgaben in dieser Übersicht.")).toBeInTheDocument();
  });

  it("reveals every static page hint through one info control", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([ownerRow()]);
    mockedApi.getRefinementTasks.mockResolvedValue([]);

    renderWithProviders(<RefinementPage />);
    await screen.findByText("Keine offenen Aufgaben in dieser Übersicht.");

    expect(screen.queryByText(strings.clarificationNeedsHint)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.effortGuideHint)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.refinementMatrixHint)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.swipeHintSize)).not.toBeInTheDocument();
    const infoButtons = screen.getAllByRole("button", {
      name: strings.showPageHints,
    });
    expect(infoButtons).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: strings.showPageHints }));

    expect(screen.getByText(strings.clarificationNeedsHint)).toBeInTheDocument();
    expect(screen.getByText(strings.effortGuideHint)).toBeInTheDocument();
    expect(screen.getByText(strings.refinementMatrixHint)).toBeInTheDocument();
    expect(screen.getByText(strings.swipeHintSize)).toBeInTheDocument();
    expect(screen.getByText(strings.swipeHintSizeChips)).toBeInTheDocument();
  });

  it("groups the refinement list by tag type without rendering value-level filter buttons", async () => {
    const kitchen = makeTag({ id: 501, name: "Küche", kind: "area" });
    mockedApi.getRefinementOwners.mockResolvedValue([
      ownerRow({ ownerId: null, ownerName: null, total: 2 }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 502, title: "Mit Bereich", effectiveOwnerId: null }),
      taskRow({ id: 503, title: "Ohne Bereich", effectiveOwnerId: null }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 502, title: "Mit Bereich", effectiveOwnerId: null, effectiveTags: [kitchen] }),
      taskRow({ id: 503, title: "Ohne Bereich", effectiveOwnerId: null }),
    ]);

    renderWithProviders(<RefinementPage />);
    await screen.findByText("Mit Bereich");

    const groupingTrigger = screen.getByRole("button", { name: /Gruppierung.*Keine/ });
    expect(
      getComputedStyle(groupingTrigger.closest(".projects-controls") as HTMLElement).marginBottom,
    ).toBe("12px");
    await userEvent.click(groupingTrigger);
    const grouping = screen.getByRole("group", { name: "Gruppieren nach" });
    expect(screen.getAllByRole("group", { name: "Gruppieren nach" })).toHaveLength(1);
    expect(grouping).toHaveAttribute("id", groupingTrigger.getAttribute("aria-controls"));
    expect(within(grouping).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Keine",
      "Kontext",
      "Person",
      "Bereich",
    ]);
    expect(screen.queryByRole("button", { name: "Küche" })).not.toBeInTheDocument();
    await userEvent.click(within(grouping).getByRole("button", { name: "Bereich" }));

    expect(groupingTrigger).toHaveAttribute("aria-expanded", "false");
    expect(groupingTrigger).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Gruppieren nach" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Küche" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ohne Bereich" })).toBeInTheDocument();
  });

  it("keeps driver repair over Arbeit klären and focuses the project editor", async () => {
    const repairIssue = issue("assign_driver", "project");
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [repairIssue],
      projects: [],
    });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: strings.refinementActionLabels.assign_driver,
      }),
    );

    expect(
      await screen.findByRole("dialog", { name: strings.editProject }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.noDriver })).toHaveFocus();
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|none|none|false",
    );
  });

  it("keeps outcome repair over Arbeit klären", async () => {
    const repairIssue = issue("add_outcome", "project");
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [repairIssue],
      projects: [],
    });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: strings.refinementActionLabels.add_outcome,
      }),
    );

    expect(
      await screen.findByRole("dialog", {
        name: `${strings.criteria}: Testprojekt`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|none|none|false",
    );
  });

  it("keeps next-action repair over Arbeit klären", async () => {
    const repairIssue = issue("add_next_action", "project");
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [repairIssue],
      projects: [],
    });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: strings.refinementActionLabels.add_next_action,
      }),
    );

    expect(
      await screen.findByPlaceholderText(strings.quickAddPlaceholder),
    ).toHaveFocus();
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|none|none|false",
    );
  });

  it("keeps completion repair over Arbeit klären and focuses the lifecycle action", async () => {
    const repairIssue = issue("review_completion", "project");
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [repairIssue],
      projects: [],
    });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: strings.refinementActionLabels.review_completion,
      }),
    );

    expect(
      await screen.findByRole("button", { name: strings.completeStory }),
    ).toHaveFocus();
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|none|none|false",
    );
  });

  it("opens the named blocking prerequisite instead of the downstream task", async () => {
    const blockerIssue = issue("clarify_task");
    blockerIssue.entityId = 34;
    blockerIssue.entityTitle = "Ikea: Kugellampe nachkaufen";
    blockerIssue.suggestedAction = {
      code: "clarify_task",
      targetTaskId: 31,
    };
    blockerIssue.blockingReason = "captured";
    blockerIssue.dependencyPath = [
      { taskId: 34, title: "Ikea: Kugellampe nachkaufen" },
      { taskId: 31, title: "Schrank Lea konfigurieren" },
    ];
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [blockerIssue],
      projects: [],
    });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Schrank Lea konfigurieren klären" }),
    );

    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|31|title|false",
    );
  });

  it.each([
    ["assign_task", "owner", false],
    ["set_followup", "dependencies", false],
    ["follow_up", "dependencies", false],
    ["plan_task", "schedule", false],
    ["resolve_blocker", "dependencies", false],
    ["add_child", "subtasks", false],
    ["clarify_task", "title", false],
  ] as const)(
    "opens task repair %s at the narrowest existing task field",
    async (actionCode, focus, queueActive) => {
      const repairIssue = issue(actionCode);
      mockedApi.getRefinementIssues.mockResolvedValue({
        issues: [repairIssue],
        projects: [],
      });

      renderWithProviders(
        <>
          <RefinementPage />
          <RepairState />
        </>,
        { initialEntries: ["/more/refinement"] },
      );

      await userEvent.click(
        await screen.findByRole("button", {
          name: strings.refinementActionLabels[actionCode],
        }),
      );
      expect(screen.getByLabelText("repair-state")).toHaveTextContent(
        `/more/refinement|41|${focus}|${String(queueActive)}`,
      );
    },
  );

  it("opens a concrete unplanned project task at its schedule field", async () => {
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [issue("plan_task", "project")],
      projects: [],
    });
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 73, projectId: 41, status: "actionable" }),
    ]);

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: strings.refinementActionLabels.plan_task,
      }),
    );
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|73|schedule|false",
    );
  });

  it("loads the project and opens its concrete planning task without leaving refinement", async () => {
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [issue("plan_task", "project")],
      projects: [],
    });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: strings.refinementActionLabels.plan_task,
      }),
    );
    await screen.findByText("Testobjekt");
    expect(mockedApi.getProject).toHaveBeenCalledWith(41);
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|73|schedule|false",
    );
  });

  it("refocuses the same issue after an incomplete task repair", async () => {
    const unresolved = issue("assign_task");
    unresolved.entityTitle = "Noch offen";
    const other = issue("add_child");
    other.entityId = 42;
    other.entityTitle = "Danach";
    mockedApi.getRefinementIssues
      .mockResolvedValueOnce({ issues: [unresolved, other], projects: [] })
      .mockResolvedValueOnce({ issues: [unresolved, other], projects: [] });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: strings.refinementActionLabels.assign_task,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Close task repair" }));

    await waitFor(() =>
      expect(mockedApi.getRefinementIssues).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.getByText("Noch offen").closest("article")).toHaveFocus(),
    );
  });

  it("focuses the next freshly unresolved issue instead of following a static queue", async () => {
    const resolved = issue("assign_task");
    resolved.entityTitle = "Wird behoben";
    const next = issue("add_child");
    next.entityId = 42;
    next.entityTitle = "Jetzt als Nächstes";
    mockedApi.getRefinementIssues
      .mockResolvedValueOnce({ issues: [resolved, next], projects: [] })
      .mockResolvedValueOnce({ issues: [next], projects: [] });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: strings.refinementActionLabels.assign_task,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Close task repair" }));

    await waitFor(() =>
      expect(screen.getByText("Jetzt als Nächstes").closest("article")).toHaveFocus(),
    );
  });

  it("returns from an in-page project repair to the refreshed issue list", async () => {
    const resolved = issue("assign_driver", "project");
    resolved.entityTitle = "Projekt klären";
    const next = issue("assign_task");
    next.entityId = 42;
    next.entityTitle = "Aufgabe klären";
    mockedApi.getRefinementIssues
      .mockResolvedValueOnce({ issues: [resolved, next], projects: [] })
      .mockResolvedValueOnce({ issues: [next], projects: [] });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: strings.refinementActionLabels.assign_driver,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.editProject });
    await userEvent.click(within(dialog).getByRole("button", { name: strings.close }));

    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|none|none|false",
    );
    await waitFor(() =>
      expect(screen.getByText("Aufgabe klären").closest("article")).toHaveFocus(),
    );
  });

  it("offers full task details without replacing the focused repair action", async () => {
    const taskIssue = issue("assign_task");
    taskIssue.entityTitle = "Aufgabendetails";
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [taskIssue],
      projects: [],
    });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      (await screen.findAllByRole("button", { name: strings.taskDetails }))[0]!,
    );
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|41|none|false",
    );
  });

  it("navigates full project details with a refinement return anchor", async () => {
    const projectIssue = issue("assign_driver", "project");
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [projectIssue],
      projects: [],
    });
    renderWithProviders(
      <>
        <Routes>
          <Route path="/more/refinement" element={<RefinementPage />} />
          <Route path="/projects/:id" element={<p>Project details</p>} />
        </Routes>
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      (await screen.findAllByRole("button", { name: strings.taskDetails }))[0]!,
    );
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/projects/41|none|none|false",
    );
    expect(screen.getByText("Project details")).toBeInTheDocument();
  });

  it("opens the displayed task's details rather than its blocker repair target", async () => {
    const blockerIssue = issue("clarify_task");
    blockerIssue.entityId = 34;
    blockerIssue.entityTitle = "Abhängige Aufgabe";
    blockerIssue.suggestedAction.targetTaskId = 31;
    mockedApi.getRefinementIssues.mockResolvedValue({
      issues: [blockerIssue],
      projects: [],
    });

    renderWithProviders(
      <>
        <RefinementPage />
        <RepairState />
      </>,
      { initialEntries: ["/more/refinement"] },
    );

    await userEvent.click(
      (await screen.findAllByRole("button", { name: strings.taskDetails }))[0]!,
    );
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/more/refinement|34|none|false",
    );
  });

  it("saves a refinement owner immediately when selected", async () => {
    mockedApi.getMembers.mockResolvedValue([
      { id: 1, name: "Mira", color: "#146356", pictureUrl: null },
      { id: 2, name: "Jonas", color: "#2563eb", pictureUrl: null },
    ]);
    mockedApi.getRefinementOwners.mockResolvedValue([
      ownerRow({ ownerId: null, ownerName: null, unestimated: 1, total: 1 }),
      ownerRow({ ownerId: 2, ownerName: "Jonas" }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 400, title: "Owner direkt wählen", effectiveOwnerId: null }),
    ]);
    mockedApi.updateTask.mockResolvedValue(
      makeTask({ id: 400, title: "Owner direkt wählen", ownerMemberId: 2 }),
    );

    renderWithProviders(<RefinementPage />);
    await screen.findByText("Owner direkt wählen");
    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Zuweisen" }));

    const group = await screen.findByRole("group", { name: "Zuständig" });
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "Jonas" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(400, {
        ownerMemberId: 2,
        ownerInheritanceMode: "explicit",
        expectedRevision: 1,
      }),
    );
    expect(screen.queryByRole("group", { name: "Zuständig" })).not.toBeInTheDocument();
  });

  it("defers the owner/list refetch (so the matrix regrouping is visible) until the retention window elapses after a swipe-driven size change", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([
      ownerRow({ ownerId: null, ownerName: null, unestimated: 1, total: 1 }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 401, title: "Neue Story schätzen", size: null, effectiveOwnerId: null }),
    ]);
    mockedApi.updateTask.mockResolvedValue(
      makeTask({ id: 401, title: "Neue Story schätzen", size: "S" }),
    );

    const { container } = renderWithProviders(<RefinementPage />);
    expect(await screen.findByText("Neue Story schätzen")).toBeInTheDocument();
    expect(mockedApi.getRefinementOwners).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();

    const content = container.querySelector(".refinement-row-content") as HTMLElement;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(content, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(content, { clientX: 100, pointerId: 1 });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockedApi.updateTask).toHaveBeenCalledWith(401, {
      size: "S",
      expectedRevision: 1,
    });

    // Row still rendered (retained) and the matrix/list have not refetched yet.
    expect(screen.getByText("Neue Story schätzen")).toBeInTheDocument();
    expect(mockedApi.getRefinementOwners).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFINEMENT_RETENTION_MS + 500);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    // Retention elapsed: the deferred global refresh finally triggered a refetch.
    expect(mockedApi.getRefinementOwners).toHaveBeenCalledTimes(2);
  });
});
