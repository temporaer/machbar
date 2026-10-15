import { ObservationPlanEditor } from "../components/ObservationPlanEditor";
import { InterventionTasksEditor } from "../components/InterventionTasksSheet";
import type { ProposedIntervention } from "@machbar/shared";
import type { AcceptGoalSuggestionInput } from "../lib/api";
import { InterventionEvidenceFacts } from "../components/InterventionEvidencePanel";
import { InterventionTasksSheet } from "../components/InterventionTasksSheet";
import { InterventionObservationPanel } from "../components/InterventionObservationPanel";
import { useState } from "react";
import { Link } from "react-router-dom";
import type {
  AssessmentProposal,
  GoalArea,
  GoalSuggestionProposal,
  GoalWithInterventions,
  InterventionView,
} from "@machbar/shared";
import { ErrorState, LoadingState } from "../components/AsyncStates";
import { GoalFormSheet } from "../components/GoalFormSheet";
import {
  InterventionFormSheet,
  type InterventionDraft,
} from "../components/InterventionFormSheet";
import {
  InterventionAssessSheet,
  type AssessmentDraft,
} from "../components/InterventionAssessSheet";
import { BottomSheet } from "../components/BottomSheet";
import { api } from "../lib/api";
import { hasApiErrorCode, localizedErrorMessage } from "../lib/errorMessage";
import { useAsync } from "../lib/useAsync";
import { useGoalActions } from "../lib/useGoalActions";
import { useStrings } from "../lib/strings";
import type { Strings } from "../lib/strings";

function derivedStateBadge(intervention: InterventionView, strings: Strings): string {
  switch (intervention.derivedState) {
    case "running":
      return strings.interventionRunningBadge;
    case "finished":
      return strings.interventionFinishedBadge;
    case "reviewed":
      return strings.interventionReviewedBadge;
  }
}

function AssessmentArc({ intervention }: { intervention: InterventionView }) {
  const strings = useStrings();
  if (intervention.assessments.length === 0) {
    return <p className="text-muted">{strings.noAssessments}</p>;
  }
  return (
    <ul className="stack goal-assessment-arc">
      {intervention.assessments.map((assessment) => (
        <li key={assessment.id} className="goal-assessment">
          <div className="row goal-assessment-head">
            <span className="badge">{strings.assessmentBandLabels[assessment.band]}</span>
            <span className="text-muted">
              {strings.assessedOn(assessment.digestWindowEnd)}
            </span>
          </div>
          <p>{assessment.rationaleMd}</p>
          {assessment.decision ? <p>{strings.interventionDecisionLabels[assessment.decision]}</p> : null}
          {assessment.benefit ? <p>{strings.interventionBenefitLabels[assessment.benefit]}</p> : null}
          {assessment.obstacle ? <p>{assessment.obstacle}</p> : null}
          {assessment.evidence ? <details><summary>{strings.interventionEvidenceTitle}</summary><InterventionEvidenceFacts evidence={assessment.evidence} /></details> : null}
          <p className="text-muted">
            {assessment.countedItemIds.length > 0
              ? `${strings.assessmentCountedItemsLabel}: ${assessment.countedItemIds.join(", ")}`
              : strings.assessmentCountedItemsEmpty}
          </p>
        </li>
      ))}
    </ul>
  );
}

function GoalCoachSuggestions({
  goal,
  pending,
  onRequest,
  onAccept,
}: {
  goal: GoalWithInterventions;
  pending: boolean;
  onRequest: (goalId: number, input?: { clarificationRequestId?: string; clarificationAnswer?: string }) => Promise<GoalSuggestionProposal>;
  onAccept: (goalId: number, requestId: string, index: number, overrides: AcceptGoalSuggestionInput) => Promise<unknown>;
}) {
  const strings = useStrings();
  const [proposal, setProposal] = useState<GoalSuggestionProposal | null>(null);
  const [pendingTaskEditors, setPendingTaskEditors] = useState<Record<number, boolean>>({});
  const [answer, setAnswer] = useState("");
  const [edits, setEdits] = useState<Record<number, Partial<ProposedIntervention>>>({});
  const patch = (index: number, value: Partial<ProposedIntervention>) => setEdits((current) => ({ ...current, [index]: { ...current[index], ...value } }));
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = async (followup = false) => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setProposal(null);
    try {
      const next = await onRequest(goal.id, followup && proposal ? { clarificationRequestId: proposal.requestId, clarificationAnswer: answer } : undefined);
      setEdits({});
      setPendingTaskEditors({});
      setProposal(next);
      if (next.status === "failed") {
        setError(next.error ?? strings.goalCoachFailed);
      } else if (next.status !== "ready") {
        setError(strings.goalCoachStillWorking);
      }
    } catch (cause) {
      setError(
        hasApiErrorCode(cause, "home_assistant_not_connected")
          ? strings.goalCoachHomeAssistantUnavailable
          : hasApiErrorCode(cause, "ai_task_not_configured")
            ? strings.goalCoachAiTaskNotConfigured
            : localizedErrorMessage(cause, strings),
      );
    } finally {
      setLoading(false);
    }
  };

  const accept = async (index: number) => {
    if (!proposal || accepting !== null) return;
    setAccepting(index);
    setError(null);
    try {
      await onAccept(goal.id, proposal.requestId, index, { ...edits[index], observationPlan: edits[index]?.observationPlan ?? proposal.interventions[index]?.observationPlan ?? { method: "reflection" } });
      setProposal(null);
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setAccepting(null);
    }
  };

  return (
    <div className="stack goal-coach" data-testid={`goal-coach-${goal.id}`}>
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending || loading || accepting !== null}
        onClick={() => void request()}
      >
        {loading ? strings.goalCoachWorking : strings.goalCoachSuggest}
      </button>
      {proposal?.clarificationQuestion ? <div className="stack">
        <label className="field">{proposal.clarificationQuestion}<textarea value={answer} maxLength={2000} onChange={(e) => setAnswer(e.target.value)} /></label>
        <button type="button" className="btn" disabled={!answer.trim() || loading} onClick={() => void request(true)}>{strings.goalCoachAnswer}</button>
      </div> : null}
      {proposal?.status === "ready" ? (
        <div className="stack">
          <p className="text-muted">{strings.goalCoachReviewHint}</p>
          {proposal.interventions.map((intervention, index) => (
            <article className="card stack" key={`${intervention.type}-${index}`}>
              <span className="badge">
                {strings.interventionTypeLabels[intervention.type]}
              </span>
              <strong>{intervention.commitment}</strong>
              {intervention.rationale ? <p>{intervention.rationale}</p> : null}
              <p className="text-muted">
                {intervention.startDate} – {intervention.revisitDate}
              </p>
              <details><summary>{strings.editIntervention}</summary>
                <label className="field">{strings.interventionCommitmentLabel}<input value={edits[index]?.commitment ?? intervention.commitment} onChange={(e) => patch(index, { commitment: e.target.value })} /></label>
                <label className="field">{strings.interventionRationaleLabel}<textarea value={edits[index]?.rationale ?? intervention.rationale} onChange={(e) => patch(index, { rationale: e.target.value })} /></label>
                <label className="field">{strings.interventionStartDateLabel}<input type="date" value={edits[index]?.startDate ?? intervention.startDate} onChange={(e) => patch(index, { startDate: e.target.value })} /></label>
                <label className="field">{strings.interventionRevisitDateLabel}<input type="date" value={edits[index]?.revisitDate ?? intervention.revisitDate} onChange={(e) => patch(index, { revisitDate: e.target.value })} /></label>
              </details>
              <ObservationPlanEditor value={edits[index]?.observationPlan ?? intervention.observationPlan ?? { method: "reflection" }} onChange={(observationPlan) => patch(index, { observationPlan })} disabled={accepting !== null} />
              <InterventionTasksEditor tasks={edits[index]?.tasks ?? intervention.tasks ?? []} onChange={(tasks) => patch(index, { tasks })} onPendingChange={(pending) => setPendingTaskEditors((current) => current[index] === pending ? current : { ...current, [index]: pending })} disabled={accepting !== null} />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={accepting !== null || pendingTaskEditors[index] === true}
                onClick={() => void accept(index)}
              >
                {accepting === index
                  ? strings.goalCoachAccepting
                  : strings.goalCoachAccept}
              </button>
            </article>
          ))}
        </div>
      ) : null}
      {error ? <div className="task-row-error" role="alert">{error}</div> : null}
    </div>
  );
}

function GoalCard({
  goal,
  onEditGoal,
  onConcludeGoal,
  onStartIntervention,
  onAdjustIntervention,
  onBackIntervention,
  onConcludeIntervention,
  onAssess,
  onRequestSuggestion,
  onAcceptSuggestion,
  pending,
}: {
  goal: GoalWithInterventions;
  onEditGoal: (goal: GoalWithInterventions) => void;
  onConcludeGoal: (goal: GoalWithInterventions) => void;
  onStartIntervention: (goal: GoalWithInterventions) => void;
  onAdjustIntervention: (intervention: InterventionView) => void;
  onBackIntervention: (intervention: InterventionView) => void;
  onConcludeIntervention: (intervention: InterventionView) => void;
  onAssess: (intervention: InterventionView) => void;
  onRequestSuggestion: (goalId: number, input?: { clarificationRequestId?: string; clarificationAnswer?: string }) => Promise<GoalSuggestionProposal>;
  onAcceptSuggestion: (
    goalId: number,
    requestId: string,
    index: number,
    overrides: AcceptGoalSuggestionInput,
  ) => Promise<unknown>;
  pending: boolean;
}) {
  const strings = useStrings();
  const interventions = [...goal.interventions].sort((a, b) =>
    b.startDate.localeCompare(a.startDate),
  );
  const hasOpenIntervention = interventions.some(
    (intervention) => intervention.status === "active",
  );
  const active = goal.status === "active";

  return (
    <section className="card stack goal-card" id={`goal-${goal.id}`} aria-label={goal.title}>
      <div className="row goal-card-head">
        <h3>{goal.title}</h3>
        <span className="badge">
          {goal.area === "work" ? strings.goalAreaWork : strings.goalAreaPersonal}
        </span>
        <span className="badge">
          {active ? strings.goalActiveBadge : strings.goalConcludedBadge}
        </span>
      </div>
      {goal.notes ? <p className="text-muted">{goal.notes}</p> : null}

      <div className="stack goal-interventions">
        <h4>{strings.currentIntervention}</h4>
        {interventions.length === 0 ? (
          <p className="text-muted">{strings.noIntervention}</p>
        ) : (
          interventions.map((intervention) => (
            <div key={intervention.id} className="stack goal-intervention">
              <div className="row goal-intervention-head">
                <span className="badge">
                  {strings.interventionTypeLabels[intervention.type]}
                </span>
                <span className="badge">{derivedStateBadge(intervention, strings)}</span>
                {intervention.backingTaskId !== null ? (
                  <span className="badge" data-testid="intervention-backed-badge">
                    {strings.interventionBackedBadge}
                  </span>
                ) : null}
              </div>
              <p>
                <strong>{intervention.commitment}</strong>
              </p>
              {intervention.rationale ? (
                <p className="text-muted">{intervention.rationale}</p>
              ) : null}
              <p className="text-muted">
                {intervention.startDate} – {intervention.revisitDate}
              </p>
              {intervention.generatedTasks?.map((task) => <p key={task.id}>{task.taskId ? <a href={`#/tasks/${task.taskId}`}>{task.title}</a> : <span>{task.title} · {strings.interventionTaskDeleted}</span>}</p>)}
              <InterventionObservationPanel interventionId={intervention.id} goalId={goal.id} goalTitle={goal.title} />
              <div className="row goal-intervention-actions">
                {active && intervention.status === "active" ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={pending}
                      onClick={() => onAdjustIntervention(intervention)}
                    >
                      {strings.editIntervention}
                    </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={pending}
                        onClick={() => onBackIntervention(intervention)}
                      >
                        {strings.backIntervention}
                      </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={pending}
                      onClick={() => onConcludeIntervention(intervention)}
                    >
                      {strings.concludeIntervention}
                    </button>
                  </>
                ) : null}
                {active && intervention.derivedState === "finished" ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={pending}
                    onClick={() => onAssess(intervention)}
                  >
                    {strings.reviewIntervention}
                  </button>
                ) : null}
              </div>
              <div className="stack goal-arc-block">
                <h5>{strings.assessmentHistory}</h5>
                <AssessmentArc intervention={intervention} />
              </div>
            </div>
          ))
        )}
      </div>

      {active ? (
        <div className="stack">
          <GoalCoachSuggestions
            goal={goal}
            pending={pending}
            onRequest={onRequestSuggestion}
            onAccept={onAcceptSuggestion}
          />
          <div className="row goal-card-actions">
            {hasOpenIntervention ? null : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={pending}
                onClick={() => onStartIntervention(goal)}
              >
                {strings.startIntervention}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
              onClick={() => onEditGoal(goal)}
            >
              {strings.editGoal}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
              onClick={() => onConcludeGoal(goal)}
            >
              {strings.concludeGoal}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function GoalsPage() {
  const strings = useStrings();
  const actions = useGoalActions();
  const goalsState = useAsync<GoalWithInterventions[]>(() => api.listGoals());

  const [creatingGoal, setCreatingGoal] = useState(false);
  const [editingGoal, setEditingGoal] = useState<GoalWithInterventions | null>(null);
  const [interventionGoal, setInterventionGoal] = useState<GoalWithInterventions | null>(null);
  const [adjustingIntervention, setAdjustingIntervention] = useState<InterventionView | null>(null);
  const [concludingBacked, setConcludingBacked] = useState<InterventionView | null>(null);
  const [assessing, setAssessing] = useState<InterventionView | null>(null);

  const goals = goalsState.data ?? [];
  const activeGoals = goals.filter((goal) => goal.status === "active");
  const concludedGoals = goals.filter((goal) => goal.status !== "active");

  const createGoal = async (input: { title: string; notes: string; area: GoalArea }) => {
    await actions.createGoal(input);
  };

  const saveGoal = async (
    goal: GoalWithInterventions,
    input: { title: string; notes: string; area: GoalArea },
  ) => {
    await actions.updateGoal(goal, { title: input.title, notes: input.notes });
  };

  const startIntervention = async (goalId: number, draft: InterventionDraft) => {
    await actions.startIntervention(goalId, draft);
  };

  const adjustIntervention = async (intervention: InterventionView, draft: InterventionDraft) => {
    await actions.adjustIntervention(intervention, draft);
  };

  const assess = async (intervention: InterventionView, draft: AssessmentDraft) => {
    if (draft.coachRequestId) {
      await actions.acceptAssessmentProposal(
        intervention.id,
        draft.coachRequestId,
        (({ coachRequestId: _requestId, digestWindowStart: _start, digestWindowEnd: _end, ...input }) => input)(draft),
      );
      return;
    }
    await actions.assessIntervention(intervention.id, draft);
  };

  const requestAssessment = (interventionId: number, input?: { benefit?: "helped" | "not_helped" | "uncertain"; obstacle?: string }): Promise<AssessmentProposal> =>
    actions.loadAssessmentProposal(interventionId, input);

  const [taskBacking, setTaskBacking] = useState<InterventionView | null>(null);
  const backIntervention = (intervention: InterventionView) => setTaskBacking(intervention);

  const concludeIntervention = (intervention: InterventionView) => {
    if (intervention.backingTaskId !== null || intervention.generatedTasks?.some((task) => task.taskId !== null)) {
      setConcludingBacked(intervention);
      return;
    }
    void actions.concludeIntervention(intervention);
  };

  const finishConcludeBacked = (cleanup: "keep" | "stop") => {
    const target = concludingBacked;
    setConcludingBacked(null);
    if (target) {
      void actions.concludeIntervention(target, cleanup);
    }
  };

  const anyPending = goalsState.loading;

  return (
    <div className="stack goals-page">
      <div className="page-header">
        <h1>{strings.goalsTitle}</h1>
      </div>
      <p className="page-subtitle">{strings.goalsExplanation}</p>

      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setCreatingGoal(true)}
        >
          {strings.newGoal}
        </button>
      </div>

      {goalsState.loading && !goalsState.data ? <LoadingState /> : null}
      {goalsState.error ? (
        <ErrorState message={goalsState.error} onRetry={goalsState.reload} />
      ) : null}

      {goalsState.data ? (
        <>
      {taskBacking ? <InterventionTasksSheet intervention={taskBacking} onClose={() => setTaskBacking(null)} /> : null}
          <section className="stack" aria-labelledby="goals-active-heading">
            <h2 id="goals-active-heading">{strings.goalsActiveHeading}</h2>
            {activeGoals.length === 0 ? (
              <p className="text-muted">{strings.goalsEmpty}</p>
            ) : (
              activeGoals.map((goal) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  pending={anyPending}
                  onEditGoal={setEditingGoal}
                  onConcludeGoal={(target) => void actions.concludeGoal(target)}
                  onStartIntervention={setInterventionGoal}
                  onAdjustIntervention={setAdjustingIntervention}
                  onBackIntervention={backIntervention}
                  onConcludeIntervention={concludeIntervention}
                  onAssess={setAssessing}
                  onRequestSuggestion={actions.loadGoalSuggestion}
                  onAcceptSuggestion={(goalId, requestId, index, overrides) =>
                    actions.acceptGoalSuggestion(goalId, requestId, { ...overrides, index })
                  }
                />
              ))
            )}
          </section>

          {concludedGoals.length > 0 ? (
            <details className="goals-concluded">
              <summary>
                {strings.goalsConcludedHeading} ({concludedGoals.length})
              </summary>
              <div className="stack">
                {concludedGoals.map((goal) => (
                  <GoalCard
                    key={goal.id}
                    goal={goal}
                    pending={anyPending}
                    onEditGoal={setEditingGoal}
                    onConcludeGoal={(target) => void actions.concludeGoal(target)}
                    onStartIntervention={setInterventionGoal}
                    onAdjustIntervention={setAdjustingIntervention}
                    onBackIntervention={backIntervention}
                    onConcludeIntervention={concludeIntervention}
                    onAssess={setAssessing}
                    onRequestSuggestion={actions.loadGoalSuggestion}
                    onAcceptSuggestion={(goalId, requestId, index, overrides) =>
                      actions.acceptGoalSuggestion(goalId, requestId, { ...overrides, index })
                    }
                  />
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : null}

      <div className="row">
        <Link className="btn" to="/more">
          {strings.back}
        </Link>
      </div>

      {creatingGoal ? (
        <GoalFormSheet onClose={() => setCreatingGoal(false)} onSave={createGoal} />
      ) : null}
      {editingGoal ? (
        <GoalFormSheet
          goal={editingGoal}
          onClose={() => setEditingGoal(null)}
          onSave={(input) => saveGoal(editingGoal, input)}
        />
      ) : null}
      {interventionGoal ? (
        <InterventionFormSheet
          onClose={() => setInterventionGoal(null)}
          onSave={(draft) => startIntervention(interventionGoal.id, draft)}
        />
      ) : null}
      {adjustingIntervention ? (
        <InterventionFormSheet
          intervention={adjustingIntervention}
          onClose={() => setAdjustingIntervention(null)}
          onSave={(draft) => adjustIntervention(adjustingIntervention, draft)}
        />
      ) : null}
      {assessing ? (
        <InterventionAssessSheet
          intervention={assessing}
          onClose={() => setAssessing(null)}
          onSave={(draft) => assess(assessing, draft)}
          onRequestCoach={(input) => requestAssessment(assessing.id, input)}
        />
      ) : null}
      {concludingBacked ? (
        <BottomSheet
          title={strings.concludeBackingTitle}
          onClose={() => setConcludingBacked(null)}
        >
          <div className="stack" data-testid="conclude-backing-prompt">
            <p>{strings.concludeBackingPrompt}</p>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => finishConcludeBacked("stop")}
              >
                {strings.concludeBackingStop}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => finishConcludeBacked("keep")}
              >
                {strings.concludeBackingKeep}
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}
