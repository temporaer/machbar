import { useState } from "react";
import { Link } from "react-router-dom";
import type {
  GoalArea,
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
import { api } from "../lib/api";
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

function GoalCard({
  goal,
  onEditGoal,
  onConcludeGoal,
  onStartIntervention,
  onAdjustIntervention,
  onConcludeIntervention,
  onAssess,
  pending,
}: {
  goal: GoalWithInterventions;
  onEditGoal: (goal: GoalWithInterventions) => void;
  onConcludeGoal: (goal: GoalWithInterventions) => void;
  onStartIntervention: (goal: GoalWithInterventions) => void;
  onAdjustIntervention: (intervention: InterventionView) => void;
  onConcludeIntervention: (intervention: InterventionView) => void;
  onAssess: (intervention: InterventionView) => void;
  pending: boolean;
}) {
  const strings = useStrings();
  const interventions = [...goal.interventions].sort((a, b) =>
    b.startDate.localeCompare(a.startDate),
  );
  const hasOpenIntervention = interventions.some(
    (intervention) => intervention.derivedState !== "reviewed",
  );
  const active = goal.status === "active";

  return (
    <section className="card stack goal-card" aria-label={goal.title}>
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
              <div className="row goal-intervention-actions">
                {active && intervention.derivedState === "running" ? (
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
    await actions.assessIntervention(intervention.id, draft);
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
                  onConcludeIntervention={(intervention) =>
                    void actions.concludeIntervention(intervention)
                  }
                  onAssess={setAssessing}
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
                    onConcludeIntervention={(intervention) =>
                      void actions.concludeIntervention(intervention)
                    }
                    onAssess={setAssessing}
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
        />
      ) : null}
    </div>
  );
}
