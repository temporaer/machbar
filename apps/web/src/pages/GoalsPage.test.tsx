import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
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
    requestGoalSuggestion: vi.fn(),
    getGoalSuggestion: vi.fn(),
    acceptGoalSuggestion: vi.fn(() => Promise.resolve({})),
    assessIntervention: vi.fn(() => Promise.resolve({})),
    requestAssessmentProposal: vi.fn(),
    getAssessmentProposal: vi.fn(),
    acceptAssessmentProposal: vi.fn(() => Promise.resolve({})),
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
    vi.useRealTimers();
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

  it("reviews task drafts before creating ordinary backing work", async () => {
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
      name: "Aufgaben dazu erstellen",
    });
    await userEvent.click(backButton);
    expect(mockedApi.backIntervention).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Aufgaben erstellen" }));
    expect(mockedApi.backIntervention).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ expectedRevision: 2 }),
    );
  });

  it("offers ordinary tasks for a non-frequency intervention", async () => {
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
      screen.queryByRole("button", { name: "Aufgaben dazu erstellen" }),
    ).toBeInTheDocument();
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

  it("requests, polls, displays, and explicitly accepts a coach suggestion", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockedApi.listGoals.mockResolvedValue([makeGoal({ interventions: [] })]);
    mockedApi.requestGoalSuggestion.mockResolvedValue({
      requestId: "suggest-1",
      goalId: 1,
      status: "queued",
      interventions: [],
      error: null,
    });
    mockedApi.getGoalSuggestion.mockResolvedValue({
      requestId: "suggest-1",
      goalId: 1,
      status: "ready",
      interventions: [{
        type: "frequency_habit",
        commitment: "Wenn ich Feierabend mache, gehe ich 20 Minuten spazieren.",
        rationale: "Klein, beobachtbar und an einen bestehenden Anker gebunden.",
        startDate: "2026-01-01",
        revisitDate: "2026-01-15",
      }],
      error: null,
    });

    renderWithProviders(<GoalsPage />);
    await user.click(
      await screen.findByRole("button", { name: "Vorschläge vom Coach" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(
      await screen.findByText(
        "Wenn ich Feierabend mache, gehe ich 20 Minuten spazieren.",
      ),
    ).toBeInTheDocument();
    expect(mockedApi.acceptGoalSuggestion).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Diesen Vorschlag übernehmen" }),
    );
    expect(mockedApi.acceptGoalSuggestion).toHaveBeenCalledWith(
      1,
      "suggest-1",
      { index: 0, observationPlan: { method: "reflection" } },
    );
  });

  it("shows a friendly inline message when Home Assistant is unavailable", async () => {
    mockedApi.listGoals.mockResolvedValue([makeGoal({ interventions: [] })]);
    mockedApi.requestGoalSuggestion.mockRejectedValue(
      Object.assign(new Error("offline"), {
        name: "ApiError",
        code: "home_assistant_not_connected",
      }),
    );
    renderWithProviders(<GoalsPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Vorschläge vom Coach" }),
    );
    expect(
      await screen.findByText(/Coach braucht eine verbundene Home-Assistant-Integration/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Experiment starten" }),
    ).toBeInTheDocument();
  });

  it("reviews an experiment ended before its future checkpoint without repeating lifecycle changes", async () => {
    const finished = makeIntervention({
      revisitDate: "2099-01-15",
      derivedState: "finished",
      assessments: [],
    });
    mockedApi.listGoals.mockResolvedValue([makeGoal({ interventions: [finished] })]);
    renderWithProviders(<GoalsPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Rückblick auf dein Experiment" }),
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Was ist passiert?" }),
      "Vier von sechs Läufen haben geklappt.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Rückblick speichern" }),
    );

    await waitFor(() =>
      expect(mockedApi.assessIntervention).toHaveBeenCalledWith(
        10,
        expect.objectContaining({
          band: "mostly_achieved",
          rationaleMd: "Vier von sechs Läufen haben geklappt.",
          decision: "stop",
          digestWindowEnd: "2026-01-15",
        }),
      ),
    );
    expect(mockedApi.requestAssessmentProposal).not.toHaveBeenCalled();
  });

  it("polls an assessment proposal and accepts the reviewed prefill", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const finished = makeIntervention({
      derivedState: "finished",
      assessments: [],
    });
    mockedApi.listGoals.mockResolvedValue([makeGoal({ interventions: [finished] })]);
    mockedApi.requestAssessmentProposal.mockResolvedValue({
      requestId: "assess-1",
      interventionId: 10,
      status: "queued",
      band: null,
      rationaleMd: null,
      countedItemIds: [],
      windowStart: "2026-01-01",
      windowEnd: "2026-01-15",
      nextMove: null,
      error: null,
    });
    mockedApi.getAssessmentProposal.mockResolvedValue({
      requestId: "assess-1",
      interventionId: 10,
      status: "ready",
      band: "achieved",
      rationaleMd: "Die dokumentierten Läufe erfüllen die vereinbarte Rate.",
      countedItemIds: [7, 8],
      windowStart: "2026-01-01",
      windowEnd: "2026-01-15",
      nextMove: "Noch zwei Wochen fortsetzen.",
      error: null,
    });
    renderWithProviders(<GoalsPage />);

    await user.click(
      await screen.findByRole("button", { name: "Rückblick auf dein Experiment" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Rückblick mit Coach vorbereiten" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(
      screen.getByDisplayValue(
        "Die dokumentierten Läufe erfüllen die vereinbarte Rate.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("7, 8")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Coach-Rückblick übernehmen" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Coach-Rückblick übernehmen" }),
    );
    expect(mockedApi.acceptAssessmentProposal).toHaveBeenCalledWith(
      10,
      "assess-1",
      expect.objectContaining({
        band: "achieved",
        rationaleMd: "Die dokumentierten Läufe erfüllen die vereinbarte Rate.",
        countedItemIds: [7, 8], countedObservationIds: [], decision: "stop", expectedRevision: 2,
      }),
    );
    expect(mockedApi.assessIntervention).not.toHaveBeenCalled();
  });
  it("answers one tailored coach question and carries it into the next proposal request", async () => {
    mockedApi.listGoals.mockResolvedValue([makeGoal({ interventions: [] })]);
    mockedApi.requestGoalSuggestion.mockResolvedValueOnce({ requestId: "question-1", goalId: 1, status: "ready", interventions: [], clarificationQuestion: "What happens after brushing?", error: null }).mockResolvedValueOnce({ requestId: "answer-1", goalId: 1, status: "ready", interventions: [{ type: "obstacle_removal", commitment: "Leave phone outside", rationale: "Reduce browsing friction", startDate: "2026-10-15", revisitDate: "2026-10-29", observationPlan: { method: "reflection" } }], error: null });
    const user = userEvent.setup(); renderWithProviders(<GoalsPage />);
    await user.click(await screen.findByRole("button", { name: "Vorschläge vom Coach" }));
    await user.type(await screen.findByLabelText("What happens after brushing?"), "I start browsing");
    await user.click(screen.getByRole("button", { name: "Antwort für den Vorschlag verwenden" }));
    expect(await screen.findByText("Leave phone outside")).toBeInTheDocument();
    expect(mockedApi.requestGoalSuggestion).toHaveBeenLastCalledWith(1, { clarificationRequestId: "question-1", clarificationAnswer: "I start browsing" });
    expect(mockedApi.acceptGoalSuggestion).not.toHaveBeenCalled();
  });

});
