import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type {
  GoalWithInterventions,
  InterventionAssessment,
  InterventionView,
} from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { GoalsPage } from "./GoalsPage";
import { api } from "../lib/api";

vi.mock("../lib/api", () => ({
  api: {
    listGoals: vi.fn(),
    getMembers: vi.fn(() => Promise.resolve([])),
  },
}));

const mockedApi = vi.mocked(api, true);

function makeAssessment(
  overrides: Partial<InterventionAssessment> = {},
): InterventionAssessment {
  return {
    id: 100,
    interventionId: 10,
    assessedAt: "2026-01-16T09:00:00.000Z",
    band: "mostly_achieved",
    rationaleMd: "Hit the gym four of six planned days.",
    digestWindowStart: "2026-01-01",
    digestWindowEnd: "2026-01-15",
    countedItemIds: [1, 2, 3],
    source: "manual",
    createdAt: "2026-01-16T09:00:00.000Z",
    ...overrides,
  };
}

function makeIntervention(
  overrides: Partial<InterventionView> = {},
): InterventionView {
  return {
    id: 10,
    revision: 2,
    goalId: 1,
    type: "frequency_habit",
    commitment: "Run three times a week",
    rationale: "",
    startDate: "2026-01-01",
    revisitDate: "2026-01-15",
    status: "concluded",
    concludedAt: "2026-01-15T00:00:00.000Z",
    backingTaskId: null,
    source: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-15T00:00:00.000Z",
    derivedState: "reviewed",
    withinReviewWindow: false,
    assessments: [makeAssessment()],
    ...overrides,
  };
}

function makeGoal(
  overrides: Partial<GoalWithInterventions> = {},
): GoalWithInterventions {
  return {
    id: 1,
    revision: 1,
    ownerMemberId: 1,
    scope: "work",
    title: "Run a half marathon",
    notes: "",
    status: "active",
    concludedAt: null,
    createdByMemberId: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    interventions: [makeIntervention()],
    ...overrides,
  };
}

describe("GoalsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a goal with its intervention and assessment arc", async () => {
    mockedApi.listGoals.mockResolvedValue([makeGoal()]);
    renderWithProviders(<GoalsPage />);

    expect(await screen.findByText("Run a half marathon")).toBeInTheDocument();
    expect(screen.getByText("Run three times a week")).toBeInTheDocument();
    // The assessment arc shows the band, rationale, and counted items.
    expect(
      screen.getByText("Hit the gym four of six planned days."),
    ).toBeInTheDocument();
    expect(screen.getByText(/1, 2, 3/)).toBeInTheDocument();
  });

  it("shows the empty state when there are no active goals", async () => {
    mockedApi.listGoals.mockResolvedValue([]);
    renderWithProviders(<GoalsPage />);

    expect(
      await screen.findByText(
        "Noch keine Ziele. Leg eins an, um ein Experiment zu starten.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Aktive Ziele" }),
    ).toBeInTheDocument();
  });

  it("collapses concluded goals into a separate section", async () => {
    mockedApi.listGoals.mockResolvedValue([
      makeGoal({ id: 1, title: "Active goal", status: "active" }),
      makeGoal({ id: 2, title: "Old goal", status: "concluded", interventions: [] }),
    ]);
    renderWithProviders(<GoalsPage />);

    expect(await screen.findByText("Active goal")).toBeInTheDocument();
    // Concluded goals live inside a <details> summary count.
    await waitFor(() => {
      expect(screen.getByText(/\(1\)/)).toBeInTheDocument();
    });
  });
});
