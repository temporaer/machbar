import { useCallback } from "react";
import {
  api,
  type AdjustInterventionInput,
  type AcceptAssessmentProposalInput,
  type AcceptGoalSuggestionInput,
  type BackInterventionInput,
  type BackingCleanup,
  type CreateGoalInput,
  type GoalWithInterventions,
  type Intervention,
  type InterventionAssessment,
  type ManualAssessmentInput,
  type StartInterventionInput,
  type UpdateGoalInput,
} from "./api";
import { pollCoachProposal } from "./goalCoach";
import { useRetainedMutations } from "./useRetainedMutations";

/**
 * The single canonical mutation path for the goals & interventions journal
 * (feature spec §9). Every goal/intervention/assessment write funnels through
 * here so the Goals page never owns transport or ad-hoc optimistic state of its
 * own. Built on {@link useRetainedMutations} for shared pending/error handling
 * and the global refresh bump that revalidates the page's `useAsync` load.
 *
 * Writes are not optimistically retained: the journal is a small authored
 * surface (not a swipe list), so each mutation simply reloads on success. Goal
 * writes are keyed by goal id and intervention/assessment writes by
 * intervention id; a goal create uses a dedicated sentinel key.
 */
const CREATE_GOAL_KEY = -1;

export function useGoalActions() {
  const { run, isPending, errors, clearError } =
    useRetainedMutations<never>();

  const recordObservation = useCallback((id: number, input: Parameters<typeof api.recordObservation>[1]) => run({ id, mutate: () => api.recordObservation(id, input), throwOnError: true }), [run]);

  const createGoal = useCallback(
    (input: CreateGoalInput) =>
      run<GoalWithInterventions>({
        id: CREATE_GOAL_KEY,
        mutate: () => api.createGoal(input),
        throwOnError: true,
      }),
    [run],
  );

  const updateGoal = useCallback(
    (goal: GoalWithInterventions, patch: UpdateGoalInput) =>
      run<GoalWithInterventions>({
        id: goal.id,
        mutate: () =>
          api.updateGoal(goal.id, {
            ...patch,
            expectedRevision: patch.expectedRevision ?? goal.revision,
          }),
        throwOnError: true,
      }),
    [run],
  );

  const concludeGoal = useCallback(
    (goal: GoalWithInterventions) =>
      run<GoalWithInterventions>({
        id: goal.id,
        mutate: () => api.concludeGoal(goal.id, goal.revision),
        throwOnError: true,
      }),
    [run],
  );

  const startIntervention = useCallback(
    (goalId: number, input: StartInterventionInput) =>
      run<Intervention>({
        id: goalId,
        mutate: () => api.startIntervention(goalId, input),
        throwOnError: true,
      }),
    [run],
  );

  const loadGoalSuggestion = useCallback(async (goalId: number, input?: Parameters<typeof api.requestGoalSuggestion>[1]) => {
    const initial = input ? await api.requestGoalSuggestion(goalId, input) : await api.requestGoalSuggestion(goalId);
    return pollCoachProposal(initial, () =>
      api.getGoalSuggestion(goalId, initial.requestId),
    );
  }, []);

  const acceptGoalSuggestion = useCallback(
    (
      goalId: number,
      requestId: string,
      input: AcceptGoalSuggestionInput,
    ) =>
      run<Intervention>({
        id: goalId,
        mutate: () => api.acceptGoalSuggestion(goalId, requestId, input),
        throwOnError: true,
      }),
    [run],
  );

  const adjustIntervention = useCallback(
    (intervention: Intervention, patch: AdjustInterventionInput) =>
      run<Intervention>({
        id: intervention.id,
        mutate: () =>
          api.adjustIntervention(intervention.id, {
            ...patch,
            expectedRevision: patch.expectedRevision ?? intervention.revision,
          }),
        throwOnError: true,
      }),
    [run],
  );

  const backIntervention = useCallback(
    (intervention: Intervention, input: BackInterventionInput = {}) =>
      run<Intervention>({
        id: intervention.id,
        mutate: () =>
          api.backIntervention(intervention.id, {
            ...input,
            expectedRevision: input.expectedRevision ?? intervention.revision,
          }),
        throwOnError: true,
      }),
    [run],
  );

  const concludeIntervention = useCallback(
    (intervention: Intervention, backingCleanup?: BackingCleanup) =>
      run<Intervention>({
        id: intervention.id,
        mutate: () =>
          api.concludeIntervention(
            intervention.id,
            intervention.revision,
            backingCleanup,
          ),
        throwOnError: true,
      }),
    [run],
  );

  const assessIntervention = useCallback(
    (interventionId: number, input: ManualAssessmentInput) =>
      run<InterventionAssessment>({
        id: interventionId,
        mutate: () => api.assessIntervention(interventionId, input),
        throwOnError: true,
      }),
    [run],
  );

  const loadAssessmentProposal = useCallback(async (interventionId: number) => {
    const initial = await api.requestAssessmentProposal(interventionId);
    return pollCoachProposal(initial, () =>
      api.getAssessmentProposal(interventionId, initial.requestId),
    );
  }, []);

  const acceptAssessmentProposal = useCallback(
    (
      interventionId: number,
      requestId: string,
      input: AcceptAssessmentProposalInput,
    ) =>
      run<InterventionAssessment>({
        id: interventionId,
        mutate: () =>
          api.acceptAssessmentProposal(interventionId, requestId, input),
        throwOnError: true,
      }),
    [run],
  );

  return {
    isPending,
    errors,
    clearError,
    createGoalKey: CREATE_GOAL_KEY,
    recordObservation,
    createGoal,
    updateGoal,
    concludeGoal,
    loadGoalSuggestion,
    acceptGoalSuggestion,
    startIntervention,
    adjustIntervention,
    backIntervention,
    concludeIntervention,
    assessIntervention,
    loadAssessmentProposal,
    acceptAssessmentProposal,
  };
}
