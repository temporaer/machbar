import { useEffect, useMemo, useRef, useState } from "react";
import { intakeDraftIssues, type IntakeDraft, type IntakeDraftCalendarEvent, type IntakeDraftWorkItem, type IntakeIssue } from "@machbar/shared";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { localizedErrorMessage, isStaleWriteConflict } from "../lib/errorMessage";
import { LoadingState } from "../components/AsyncStates";

function IssueText({ issue, path }: { issue: IntakeIssue; path: (string | number)[] }) {
  return JSON.stringify(issue.path) === JSON.stringify(path) ? (
    <small className="field-error" role="alert">{issue.message}</small>
  ) : null;
}

export function IntakeReviewPage() {
  const { id = "" } = useParams();
  const strings = useStrings();
  const navigate = useNavigate();
  const { members } = useIdentity();
  const { version } = useRefresh();
  const state = useAsync(() => api.getIntake(id), [id]);
  const [record, setRecord] = useState(state.data);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const draftLoaded = useRef(false);

  useEffect(() => {
    if (state.data) {
      setRecord(state.data);
      if (state.data.draft) setDraft(state.data.draft);
      draftLoaded.current = true;
    }
  }, [state.data]);
  useEffect(() => {
    if (!draft || !draftLoaded.current || record?.status !== "ready" || !record) return;
    const revision = record.revision;
    const timer = window.setTimeout(() => {
      void api.updateIntakeDraft(id, {
        expectedRevision: revision,
        draft,
      }).then((next) => setRecord(next)).catch((cause) => {
        if (isStaleWriteConflict(cause)) state.reload();
      });
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [draft, id, record?.revision, record?.status, state.reload]);
  useEffect(() => {
    if (!record || !["queued", "analyzing", "applying"].includes(record.status)) return;
    const timer = window.setInterval(state.reload, 2_000);
    return () => window.clearInterval(timer);
  }, [record?.status, state.reload, version]);

  const issues = useMemo(
    () => (draft ? intakeDraftIssues(draft, {
      memberIds: members.map((member) => member.id),
      paperlessAvailable: record?.paperlessAvailable ?? false,
      hasFiles: (record?.attachments.length ?? 0) > 0,
    }) : []),
    [draft, members, record],
  );
  if (state.loading && !record) return <LoadingState />;
  if (state.error && !record) {
    return <section className="card stack" role="alert"><h1>{strings.intakeExpired}</h1><p>{state.error}</p><Link className="btn" to="/today">{strings.toMachbar}</Link></section>;
  }
  if (!record) return null;

  const updateDraft = (next: IntakeDraft) => {
    setDraft(next);
    setRecord({ ...record, draft: next });
  };
  const retry = async () => {
    setBusy(true);
    try { setRecord(await api.retryIntake(id)); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!draft || issues.length) return;
    setBusy(true);
    try { setRecord(await api.applyIntake(id, { expectedRevision: record.revision, draft })); }
    catch (cause) {
      if (isStaleWriteConflict(cause)) state.reload();
    } finally { setBusy(false); }
  };
  const discard = async () => {
    setBusy(true);
    try { await api.deleteIntake(id); navigate("/today"); } finally { setBusy(false); }
  };
  if (record.status === "analysis_failed") {
    return <section className="card stack" role="alert"><h1>{strings.intakeAnalysisFailed}</h1><p>{record.error?.message ?? strings.intakeAnalysisFailed}</p><button className="btn btn-primary" disabled={busy} onClick={() => void retry()}>{strings.intakeRetry}</button></section>;
  }
  if (record.status === "queued") return <section className="card stack"><h1>{strings.intakeProcess}</h1><p>{strings.intakeQueued}</p>{!record.homeAssistant.workerOnline ? <p role="status">{strings.intakeOfflineHint}</p> : null}</section>;
  if (record.status === "analyzing") return <section className="card stack"><h1>{strings.intakeProcess}</h1><p>{strings.intakeAnalyzing}</p></section>;
  if (record.status === "applying") return <section className="card stack"><h1>{strings.intakeApply}</h1><p>{strings.intakeApplying}</p></section>;
  if (record.status === "applied" || record.status === "partially_applied") {
    return <section className="card stack"><h1>{record.status === "applied" ? strings.intakeApplied : strings.intakePartiallyApplied}</h1>
      {record.applyResults?.work.map((item) => <Link key={item.key} to={item.role === "story" ? `/projects/${item.workItemId}` : `/tasks/${item.workItemId}`}>{item.key}</Link>)}
      {record.status === "partially_applied" ? <button className="btn btn-primary" disabled={busy} onClick={() => void apply()}>{strings.intakeRetryApply}</button> : null}
    </section>;
  }
  if (!draft) return <LoadingState />;
  return <section className="stack intake-review">
    <h1>{strings.intakeReady}</h1>
    <label className="field"><span>{strings.notes}</span><textarea value={draft.summary} onChange={(event) => updateDraft({ ...draft, summary: event.target.value })} /></label>
    {draft.warnings.length ? <section role="status"><h2>{strings.intakeWarnings}</h2><ul>{draft.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul></section> : null}
    <h2>{strings.intakeCalendar}</h2>
    {draft.calendarEvents.map((event, index) => <CalendarEditor key={event.key} event={event} issues={issues} onChange={(next) => updateDraft({ ...draft, calendarEvents: draft.calendarEvents.map((item, i) => i === index ? next : item) })} />)}
    <h2>{strings.intakeMachbar}</h2>
    {draft.workItems.map((item, index) => <WorkEditor key={item.key} item={item} index={index} members={members} issues={issues} onChange={(next) => {
      const items = draft.workItems.map((value, i) => i === index ? next : value);
      if (!next.enabled) {
        const disabled = new Set([next.key]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const value of items) {
            if (value.parentKey && disabled.has(value.parentKey) && !disabled.has(value.key)) {
              disabled.add(value.key);
              changed = true;
            }
          }
        }
        updateDraft({ ...draft, workItems: items.map((value) => disabled.has(value.key) ? { ...value, enabled: false } : value) });
      } else {
        updateDraft({ ...draft, workItems: items });
      }
    }} />)}
    <div className="row"><button className="btn btn-primary" disabled={busy || issues.length > 0} onClick={() => void apply()}>{strings.intakeApply}</button><button className="btn" disabled={busy} onClick={() => void discard()}>{strings.intakeDiscard}</button></div>
    {issues.length ? <p role="alert">{issues[0]?.message}</p> : null}
  </section>;
}

function CalendarEditor({ event, issues, onChange }: { event: IntakeDraftCalendarEvent; issues: IntakeIssue[]; onChange: (event: IntakeDraftCalendarEvent) => void }) {
  const strings = useStrings();
  return <article className="card stack"><label><input type="checkbox" checked={event.enabled} onChange={(e) => onChange({ ...event, enabled: e.target.checked })} /> {event.title}</label>
    <input value={event.title} onChange={(e) => onChange({ ...event, title: e.target.value })} />
    <label><input type="checkbox" checked={event.allDay} onChange={(e) => onChange({ ...event, allDay: e.target.checked })} /> {strings.intakeCalendar}</label>
    <input aria-label="start" value={event.allDay ? event.startDate ?? "" : event.startDateTime ?? ""} onChange={(e) => onChange(event.allDay ? { ...event, startDate: e.target.value } : { ...event, startDateTime: e.target.value })} />
    <input aria-label="end" value={event.allDay ? event.endDate ?? "" : event.endDateTime ?? ""} onChange={(e) => onChange(event.allDay ? { ...event, endDate: e.target.value } : { ...event, endDateTime: e.target.value, durationAssumed: false })} />
    <input aria-label="location" value={event.location ?? ""} onChange={(e) => onChange({ ...event, location: e.target.value || null })} />
    <textarea aria-label="description" value={event.description ?? ""} onChange={(e) => onChange({ ...event, description: e.target.value || null })} />
    {event.durationAssumed ? <span className="badge">{strings.intakeAssumedDuration}</span> : null}<IssueText issue={issues.find((i) => i.code === "timed_end_required") ?? { path: [], code: "timed_end_required", message: "" }} path={["calendarEvents", 0, "endDateTime"]} />
  </article>;
}

function WorkEditor({ item, index, members, issues, onChange }: { item: IntakeDraftWorkItem; index: number; members: { id: number; name: string }[]; issues: IntakeIssue[]; onChange: (item: IntakeDraftWorkItem) => void }) {
  const strings = useStrings();
  return <article className="card stack" style={{ marginInlineStart: `${Math.min(index, 5) * 1}rem` }}><label><input type="checkbox" checked={item.enabled} onChange={(e) => onChange({ ...item, enabled: e.target.checked })} /> {item.title}</label>
    <select value={item.kind} onChange={(e) => onChange({ ...item, kind: e.target.value as IntakeDraftWorkItem["kind"] })}><option value="action">Action</option><option value="project">Project</option><option value="reference">Reference</option></select>
    <input value={item.title} onChange={(e) => onChange({ ...item, title: e.target.value })} />
    <select aria-label={strings.owner} value={item.ownerMemberId ?? ""} onChange={(e) => onChange({ ...item, ownerMemberId: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
    <textarea aria-label={strings.notes} value={item.notes ?? ""} onChange={(e) => onChange({ ...item, notes: e.target.value || null })} />
    {item.kind !== "reference" ? <label>{strings.due}<input value={item.dueDate ?? ""} onChange={(e) => onChange({ ...item, dueDate: e.target.value || null })} /></label> : null}
    {item.kind === "action" ? <>
      <label>{strings.scheduled}<input value={item.scheduledDate ?? ""} onChange={(e) => onChange({ ...item, scheduledDate: e.target.value || null })} /></label>
      <label>{strings.notBefore}<input value={item.notBeforeDate ?? ""} onChange={(e) => onChange({ ...item, notBeforeDate: e.target.value || null, notBeforeAt: e.target.value ? item.notBeforeAt : null })} /></label>
      <label>{strings.reminder}<input value={item.reminderAt ?? ""} onChange={(e) => onChange({ ...item, reminderAt: e.target.value || null })} /></label>
      <label><input type="checkbox" checked={item.needsClarification} onChange={(e) => onChange({ ...item, needsClarification: e.target.checked, reminderAt: e.target.checked ? null : item.reminderAt })} /> Klärung nötig</label>
    </> : null}
  </article>;
}
