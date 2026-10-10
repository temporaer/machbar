import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { IntakeRecord, WorkRefinementChange } from "@machbar/shared";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";

const labels = {
  update_task: "refinementTitle", update_project: "refinementTitle", convert_task_to_project: "refinementConvert", create_child: "refinementCreate",
  move_task: "refinementMove", add_dependency: "refinementDependency", update_wait: "refinementWait",
  update_project_outcome: "refinementOutcome", advisory: "refinementAdvisory",
} as const;

export function WorkRefinementReview({ record, onChange }: { record: IntakeRecord; onChange: (record: IntakeRecord) => void }) {
  const strings = useStrings();
  const navigate = useNavigate();
  const refinement = record.refinement;
  const [proposalDraft, setProposalDraft] = useState(refinement?.proposal ?? null);
  useEffect(() => { setProposalDraft(refinement?.proposal ?? null); }, [record.revision, record.status, refinement?.proposal]);
  const proposal = proposalDraft ?? refinement?.proposal;
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!refinement || !proposal) return null;
  const update = (index: number, patch: Partial<WorkRefinementChange>) => {
    const changes = proposal.changes.map((item, i) => i === index ? { ...item, ...patch } as WorkRefinementChange : item);
    setProposalDraft({ ...proposal, changes });
  };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const next = await api.updateWorkRefinement(record.id, { expectedRevision: record.revision, proposal }); onChange(next); setProposalDraft(next.refinement?.proposal ?? null);
    } catch (cause) { setError(localizedErrorMessage(cause, strings)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const current = await api.updateWorkRefinement(record.id, { expectedRevision: record.revision, proposal });
      onChange(current);
      onChange(await api.applyWorkRefinement(record.id, { expectedRevision: current.revision }));
    } catch (cause) { setError(localizedErrorMessage(cause, strings)); }
    finally { setBusy(false); }
  };
  const regenerate = async () => {
    setBusy(true); setError(null);
    try { onChange(await api.retryIntake(record.id, answer)); setAnswer(""); }
    catch (cause) { setError(localizedErrorMessage(cause, strings)); }
    finally { setBusy(false); }
  };
  const discard = async () => {
    setBusy(true);
    try { await api.deleteIntake(record.id); navigate("/today"); }
    catch (cause) { setError(localizedErrorMessage(cause, strings)); }
    finally { setBusy(false); }
  };
  const label = (change: WorkRefinementChange) => strings[labels[change.kind]];
  const contextLabels = new Map<number, { title: string; path: string }>();
  try {
    const walk = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      if (typeof item.id === "number" && typeof item.title === "string") {
        const role = Array.isArray(item.tasks) || Array.isArray(item.projects) ? "projects" : "tasks";
        contextLabels.set(item.id, { title: item.title, path: `/${role}/${item.id}` });
      }
      for (const key of ["children", "tasks", "projects"]) if (Array.isArray(item[key])) item[key].forEach(walk);
    };
    if (record.text) walk(JSON.parse(record.text));
  } catch { /* a legacy intake's text need not be JSON */ }
  return <main className="page stack">
    <header className="stack"><p className="eyebrow">{strings.workRefinement}</p><h1>{refinement.targetType === "project" ? strings.project : strings.task}</h1></header>
    <section className="card stack">
      <h2>{proposal.disposition === "leave_alone" ? strings.refinementLeaveAlone : proposal.summary}</h2>
      {record.error ? <p role="alert" className="error-text">{record.error.message}</p> : null}
      {proposal.question ? <><strong>{strings.refinementQuestionLabel}</strong><p>{proposal.question}</p></> : null}
      {proposal.changes.map((change, index) => <article className="card stack" key={`${change.kind}-${index}`}>
        <label className="inline-row"><input type="checkbox" checked={change.accepted} disabled={change.kind === "advisory" || busy} onChange={(event) => update(index, { accepted: event.target.checked })} /><strong>{label(change)}</strong></label>
        {Object.entries(change).filter(([key, value]) => ["targetId", "taskId", "parentTaskId", "projectId", "dependsOnTaskId"].includes(key) && typeof value === "number").map(([key, value]) => {
          const context = contextLabels.get(value as number);
          return <small key={key}>{context ? <Link to={context.path} target="_blank" rel="noreferrer">{context.title}</Link> : `#${value}`}</small>;
        })}
        <p>{change.rationale}</p>
        {"title" in change ? <label className="stack"><span>{strings.title}</span><input value={change.title} onChange={(event) => update(index, { title: event.target.value })} /></label> : null}
        {"notes" in change && change.notes !== undefined ? <label className="stack"><span>{strings.notes}</span><textarea value={change.notes ?? ""} onChange={(event) => update(index, { notes: event.target.value })} /></label> : null}
        {change.kind === "update_wait" ? <label className="stack"><span>{strings.refinementWait}</span><input value={change.waitingFor} onChange={(event) => update(index, { waitingFor: event.target.value })} /></label> : null}
        {change.kind === "update_project_outcome" ? <label className="stack"><span>{strings.refinementOutcome}</span><textarea value={change.outcome} onChange={(event) => update(index, { outcome: event.target.value })} /></label> : null}
        {change.kind === "move_task" ? <label className="stack"><span>{strings.position}</span><input type="number" min={0} value={change.position} onChange={(event) => update(index, { position: Number(event.target.value) })} /></label> : null}
        {change.kind === "advisory" ? <p>{change.title}</p> : null}
      </article>)}
      <label className="stack"><span>{proposal.question ? strings.refinementAnswerLabel : strings.refinementFeedbackLabel}</span><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={proposal.question ?? strings.workRefinementPlaceholder} /></label>
      {error ? <p role="alert" className="error-text">{error}</p> : null}
      <div className="actions">
        {answer.trim() ? <button className="btn" disabled={busy} onClick={() => void regenerate()}>{proposal.question ? strings.refinementRegenerate : strings.refinementRegenerateFeedback}</button> : null}
        <button className="btn btn-primary" disabled={busy || record.status !== "ready" || proposal.disposition === "clarification"} onClick={() => void apply()}>{strings.refinementApply}</button>
        <button className="btn" disabled={busy} onClick={() => void save()}>{strings.save}</button>
        <button className="btn" disabled={busy} onClick={() => void discard()}>{strings.intakeDiscard}</button>
      </div>
    </section>
  </main>;
}
