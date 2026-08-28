import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import type { RefinementIssue } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { de as strings } from "../i18n/de";
import type { OwnerSizeCounts, RefinementTaskRow } from "../lib/api";
import { REFINEMENT_RETENTION_MS } from "../lib/useRefinementActions";
import { makeTag, makeTask } from "../test/fixtures";
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
    ...overrides,
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
    <output aria-label="repair-state">
      {location.pathname}
      {location.search}|{taskDetail.openTaskId ?? "none"}|
      {taskDetail.focusField ?? "none"}|{String(taskDetail.queueActive)}
    </output>
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
    expect(screen.getByRole("button", { name: "Mira" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gemeinsam / offen" })).toBeInTheDocument();
    expect(screen.getByText(/Hausumbau/)).toBeInTheDocument();
    expect(screen.getByText("Rasen mähen")).toBeInTheDocument();
  });

  it("merges blocked/waiting-for context from the unfiltered task search into the refinement list", async () => {
    mockedApi.getRefinementOwners.mockResolvedValue([ownerRow({ ownerId: null, ownerName: null })]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 201, title: "Handwerker anrufen", status: "waiting", effectiveOwnerId: null }),
    ]);
    mockedApi.searchTasks.mockResolvedValue([
      makeTask({ id: 201, status: "waiting", waitingFor: "Rückruf vom Handwerker", blocked: true }),
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
    mockedApi.searchTasks.mockResolvedValue([
      makeTask({ id: 502, effectiveTags: [kitchen] }),
      makeTask({ id: 503 }),
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

  it.each([
    ["assign_driver", "driver"],
    ["add_outcome", "outcome"],
    ["add_next_action", "next-action"],
    ["review_completion", "completion"],
  ] as const)(
    "deep-links project repair %s to its focused existing editor",
    async (actionCode, focus) => {
      const repairIssue = issue(actionCode, "project");
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
        `/projects/41?focus=${focus}|none|none|false`,
      );
    },
  );

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
      "/more/refinement|31|title|true",
    );
  });

  it.each([
    ["assign_task", "owner", false],
    ["set_followup", "schedule", false],
    ["follow_up", "schedule", false],
    ["plan_task", "schedule", false],
    ["resolve_blocker", "dependencies", false],
    ["add_child", "subtasks", false],
    ["clarify_task", "title", true],
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
    mockedApi.searchTasks.mockResolvedValue([
      makeTask({ id: 73, projectId: 41, status: "actionable" }),
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

  it("keeps project planning repair focused through route state while task context is still loading", async () => {
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
    expect(screen.getByLabelText("repair-state")).toHaveTextContent(
      "/projects/41?focus=planning|none|none|false",
    );
  });

  it("defers the owner/list refetch (so the matrix regrouping is visible) until the retention window elapses after a swipe-driven size change", async () => {
    vi.useFakeTimers();
    mockedApi.getRefinementOwners.mockResolvedValue([
      ownerRow({ ownerId: null, ownerName: null, unestimated: 1, total: 1 }),
    ]);
    mockedApi.getRefinementTasks.mockResolvedValue([
      taskRow({ id: 401, title: "Neue Story schätzen", size: null, effectiveOwnerId: null }),
    ]);
    mockedApi.updateTask.mockResolvedValue(
      makeTask({ id: 401, size: "S" }),
    );

    const { container } = renderWithProviders(<RefinementPage />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByText("Neue Story schätzen")).toBeInTheDocument();
    expect(mockedApi.getRefinementOwners).toHaveBeenCalledTimes(1);

    const content = container.querySelector(".refinement-row-content") as HTMLElement;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(content, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(content, { clientX: 100, pointerId: 1 });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockedApi.updateTask).toHaveBeenCalledWith(401, { size: "S" });

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
