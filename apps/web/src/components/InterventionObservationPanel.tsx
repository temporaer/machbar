import { useState } from "react";
import type { DueInterventionReport, InterventionObservation, ObservationAnswer } from "@machbar/shared";
import { Link } from "react-router-dom";
import { useGoalActions } from "../lib/useGoalActions";
import { useStrings } from "../lib/strings";
import { useAsync } from "../lib/useAsync";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";

export function InterventionReportCard({ report, observation }: { report: DueInterventionReport; observation?: InterventionObservation }) {
  const s = useStrings(), actions = useGoalActions();
  const [notes, setNotes] = useState(observation?.notes ?? ""), [saved, setSaved] = useState(false), [error, setError] = useState<string | null>(null);
  const plan = report.plan.plan;
  if (plan.method !== "daily_report") return null;
  const submit = async (answer: ObservationAnswer) => {
    try { setError(null); await actions.recordObservation(report.interventionId, { referenceDate: report.referenceDate, answer, notes, expectedRevision: observation?.revision ?? 0 }); setSaved(true); }
    catch (e) { setError(localizedErrorMessage(e, s)); }
  };
  return <article className="card stack">
    <Link to={`/more/goals#goal-${report.goalId}`}>{report.goalTitle}</Link>
    <strong>{s.observationReferenceDate}: {report.referenceDate}</strong>
    <p>{plan.question}</p>
    {saved ? <p role="status">{s.observationSaved}</p> : <>
      {observation ? <p>{s.observationAnswers[observation.answer]}</p> : null}
      <div className="intervention-observation-answers">{(["met", "not_met", "unknown", ...(plan.opportunityBased ? ["no_opportunity"] : [])] as ObservationAnswer[]).map((answer) => <button type="button" className="btn btn-sm" key={answer} disabled={actions.isPending(report.interventionId)} onClick={() => void submit(answer)}>{s.observationAnswers[answer]}</button>)}</div>
      <details><summary>{s.observationOptionalNotes}</summary><textarea value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} /></details>
    </>}
    {error ? <p role="alert">{error}</p> : null}
  </article>;
}
export function InterventionObservationPanel({ interventionId, goalId, goalTitle }: { interventionId: number; goalId: number; goalTitle: string }) {
  const s = useStrings();
  const [historyLimit, setHistoryLimit] = useState(30);
  const { data, error } = useAsync(() => api.observationHistory(interventionId), [interventionId]);
  return <details><summary>{s.observationHistory}</summary>
    {error ? <p role="alert">{localizedErrorMessage(error, s)}</p> : null}
    {data ? <div className="stack">
      {(data.recentReports ?? []).map((r) => <InterventionReportCard key={`missing-${r.referenceDate}`} report={{ ...r, interventionId, goalId, goalTitle }} />)}
      {data.observations.slice(-historyLimit).reverse().map((o) => { const plan = data.plans.find((p) => p.id === o.planVersionId); return plan ? <InterventionReportCard key={`${o.id}-${o.revision}`} report={{ interventionId, goalId, goalTitle, referenceDate: o.referenceDate, plan }} observation={o} /> : null; })}
      {data.observations.length > historyLimit ? <button type="button" className="btn" onClick={() => setHistoryLimit((limit) => limit + 30)}>{s.observationOlder}</button> : null}
      {!data.plans.length ? <p>{s.observationNoPlan}</p> : null}
    </div> : null}
  </details>;
}
