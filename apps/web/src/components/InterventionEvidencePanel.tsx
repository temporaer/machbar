import type { InterventionEvidence } from "@machbar/shared";
import { useAsync } from "../lib/useAsync";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { ObservationPlanSummary } from "./ObservationPlanEditor";

export interface EvidenceSelection {
  observationIds: number[];
  itemIds: number[];
  onObservationChange?: (ids: number[]) => void;
  onItemChange?: (ids: number[]) => void;
}
export function InterventionEvidenceFacts({ evidence, selection }: { evidence: InterventionEvidence; selection?: EvidenceSelection | undefined }) {
  const s = useStrings(), c = evidence.counts;
  const toggle = (ids: number[], id: number, checked: boolean) => checked ? [...ids, id] : ids.filter((v) => v !== id);
  const relevantPlans = evidence.plans.filter((p, index) => p.effectiveFrom <= evidence.window.endDate && (!evidence.plans[index + 1] || evidence.plans[index + 1]!.effectiveFrom > evidence.window.startDate));
  const daily = relevantPlans.some((p) => p.plan.method === "daily_report");
  const taskFacts = [
    ...evidence.activity.history.finiteCompletions.flatMap((t) => t.id === null ? [] : [{ id: t.id, text: `${t.title} · ${t.date}` }]),
    ...evidence.activity.history.bulkCompletionGroups.map((t) => ({ id: t.id, text: `${t.title} · ${t.date} · ${t.count}` })),
    ...evidence.activity.history.recurringWork.map((t) => ({ id: t.taskId, text: `${t.title} · ${s.interventionBackingTally(t.completed, t.missed)} · ${t.representatives.map((r) => r.date).join(", ")}` })),
  ];
  const reports = <>
    <p>{s.interventionCoverage(c.reported, c.eligible)}</p>
    <ul><li>{s.observationAnswers.met}: {c.met}</li><li>{s.observationAnswers.not_met}: {c.notMet}</li><li>{s.observationAnswers.unknown}: {c.unknown}</li><li>{s.observationAnswers.no_opportunity}: {c.noOpportunity}</li><li>{s.interventionMissing}: {c.missing}</li></ul>
    {evidence.periods.map((p) => <p key={`${p.planVersionId}-${p.startDate}`}>{p.startDate} – {p.endDate}: {p.counts.met} / {p.target.successfulDays} {p.partial ? s.interventionPartialWindow : ""}</p>)}
    {evidence.observations.map((o) => {
      const version = evidence.plans.find((p) => p.id === o.planVersionId);
      return <div className="card stack" key={o.id}>
        {selection ? <label><input type="checkbox" checked={selection.observationIds.includes(o.id)} disabled={!selection.onObservationChange} onChange={(e) => selection.onObservationChange?.(toggle(selection.observationIds, o.id, e.target.checked))} /> {s.interventionCitedEvidence}: {o.referenceDate}</label> : <strong>{o.referenceDate}</strong>}
        {version ? <><p>{version.commitment}</p><ObservationPlanSummary plan={version.plan} /><p>{version.timezone}</p></> : null}
        <p>{s.observationAnswers[o.answer]}</p>{o.notes ? <p>{o.notes}</p> : null}
      </div>;
    })}
  </>;
  const tasks = <>
    <strong>{s.interventionTaskEvidence}</strong>
    {taskFacts.map((t, index) => <div key={`${t.id}-${index}`}>{selection ? <label><input type="checkbox" checked={selection.itemIds.includes(t.id)} disabled={!selection.onItemChange} onChange={(e) => selection.onItemChange?.(toggle(selection.itemIds, t.id, e.target.checked))} /> {s.interventionCitedEvidence}: {t.text}</label> : <p>{t.text}</p>}</div>)}
    {!taskFacts.length ? <p>{s.interventionNoTaskEvidence}</p> : null}
  </>;
  return <section className="card stack" aria-label={s.interventionEvidenceTitle}>
    <strong>{s.interventionEvidenceTitle} · {evidence.window.startDate} – {evidence.window.endDate}</strong>
    {selection ? <p className="text-muted">{s.interventionCitationHint}</p> : null}
    {daily ? reports : null}
    {relevantPlans.map((p) => <div key={p.id}><span>{p.effectiveFrom}</span><ObservationPlanSummary plan={p.plan} /></div>)}
    {tasks}
    <p className="text-muted">{s.interventionEvidenceCaveat}</p>
    <details><summary>{s.interventionRelatedActivity}</summary><pre style={{ whiteSpace: "pre-wrap" }}>{evidence.activity.markdown}</pre></details>
  </section>;
}
export function InterventionEvidencePanel({ interventionId, startDate, endDate, selection }: { interventionId: number; startDate: string; endDate: string; selection?: EvidenceSelection | undefined }) {
  const { data, error } = useAsync(() => api.interventionEvidence(interventionId, startDate, endDate), [interventionId, startDate, endDate]);
  return data ? <InterventionEvidenceFacts evidence={data} selection={selection} /> : error ? <p role="alert">{error}</p> : null;
}
