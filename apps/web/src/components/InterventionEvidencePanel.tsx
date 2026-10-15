import type { InterventionEvidence } from "@machbar/shared";
import { useAsync } from "../lib/useAsync";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";

export function InterventionEvidenceFacts({ evidence }: { evidence: InterventionEvidence }) {
  const s = useStrings(), c = evidence.counts;
  const createdIds = new Set(evidence.generatedTasks.map((t) => t.originalTaskId));
  const completions = evidence.activity.history.finiteCompletions.filter((t) => t.id !== null && createdIds.has(t.id));
  const recurring = evidence.activity.history.recurringWork.filter((t) => createdIds.has(t.taskId));
  return <section className="card stack" aria-label={s.interventionEvidenceTitle}>
    <strong>{s.interventionEvidenceTitle} · {evidence.window.startDate} – {evidence.window.endDate}</strong>
    <p>{s.interventionCoverage(c.reported, c.eligible)}</p>
    <ul><li>{s.observationAnswers.met}: {c.met}</li><li>{s.observationAnswers.not_met}: {c.notMet}</li><li>{s.observationAnswers.unknown}: {c.unknown}</li><li>{s.observationAnswers.no_opportunity}: {c.noOpportunity}</li><li>{s.interventionMissing}: {c.missing}</li></ul>
    {evidence.periods.map((p) => <p key={`${p.planVersionId}-${p.startDate}`}>{p.startDate} – {p.endDate}: {p.counts.met} / {p.target.successfulDays} {p.partial ? s.interventionPartialWindow : ""}</p>)}
    <strong>{s.interventionCreatedTaskEvidence}</strong>
    {completions.map((t) => <p key={`${t.id}-${t.date}`}>{t.title} · {t.date}</p>)}
    {recurring.map((t) => <p key={t.taskId}>{t.title} · {s.interventionBackingTally(t.completed, t.missed)}</p>)}
    {!completions.length && !recurring.length ? <p>{s.interventionNoTaskEvidence}</p> : null}
    <p className="text-muted">{s.interventionEvidenceCaveat}</p>
    <details><summary>{s.interventionRelatedActivity}</summary><pre style={{ whiteSpace: "pre-wrap" }}>{evidence.activity.markdown}</pre></details>
  </section>;
}
export function InterventionEvidencePanel({ interventionId, startDate, endDate }: { interventionId: number; startDate: string; endDate: string }) {
  const { data, error } = useAsync(() => api.interventionEvidence(interventionId, startDate, endDate), [interventionId, startDate, endDate]);
  return data ? <InterventionEvidenceFacts evidence={data} /> : error ? <p role="alert">{error}</p> : null;
}
