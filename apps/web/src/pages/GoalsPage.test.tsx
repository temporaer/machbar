import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    backIntervention: vi.fn(() => Promise.resolve({})),
    concludeIntervention: vi.fn(() => Promise.resolve({})),
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
    area: "work",
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

  it("offers backing only for a running, unbacked frequency habit", async () => {
    const running = makeIntervention({
      status: "active",
      concludedAt: null,
      derivedState: "running",
      assessments: [],
      backingTaskId: null,
    });
    mockedApi.listGoals.mockResolvedValue([makeGoal({ interventions: [running] })]);
    renderWithProviders(<GoalsPage />);

    const backButton = await screen.findByRole("button", {
      name: "Mit Check-in hinterlegen",
    });
    await userEvent.click(backButton);
    expect(mockedApi.backIntervention).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ expectedRevision: 2 }),
    );
  });

  it("hides backing for a non-frequency-habit intervention", async () => {
    const running = makeIntervention({
      type: "obstacle_removal",
      status: "active",
      concludedAt: null,
      derivedState: "running",
      assessments: [],
      backingTaskId: null,
    });
    mockedApi.listGoals.mockResolvedValue([makeGoal({ interventions: [running] })]);
    renderWithProviders(<GoalsPage />);

    await screen.findByText("Run three times a week");
    expect(
      screen.queryByRole("button", { name: "Mit Check-in hinterlegen" }),
    ).toBeNull();
  });

  it("prompts keep/stop when concluding a backed intervention and defaults to stop", async () => {
    const backed = makeIntervention({
      status: "active",
      concludedAt: null,
      derivedState: "running",
      assessments: [],
      backingTaskId: 77,
    });
    mockedApi.listGoals.mockResolvedValue([makeGoal({ interventions: [backed] })]);
    renderWithProviders(<GoalsPage />);

    const concludeButton = await screen.findByRole("button", {
      name: "Experiment beenden",
    });
    await userEvent.click(concludeButton);

    // A keep/stop prompt appears rather than concluding immediately.
    const prompt = await screen.findByTestId("conclude-backing-prompt");
    expect(mockedApi.concludeIntervention).not.toHaveBeenCalled();

    await userEvent.click(
      within(prompt).getByRole("button", { name: "Aufgabe beenden (Standard)" }),
    );
    expect(mockedApi.concludeIntervention).toHaveBeenCalledWith(10, 2, "stop");
  });

  it("keeps the backing task when chosen on conclude", async () => {
    const backed = makeIntervention({
      status: "active",
      concludedAt: null,
      derivedState: "running",
      assessments: [],
      backingTaskId: 77,
    });
    mockedApi.listGoals.mockResolvedValue([makeGoal({ interventions: [backed] })]);
    renderWithProviders(<GoalsPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Experiment beenden" }),
    );
    const prompt = await screen.findByTestId("conclude-backing-prompt");
    await userEvent.click(
      within(prompt).getByRole("button", { name: "Aufgabe behalten" }),
    );
    expect(mockedApi.concludeIntervention).toHaveBeenCalledWith(10, 2, "keep");
  });
});
