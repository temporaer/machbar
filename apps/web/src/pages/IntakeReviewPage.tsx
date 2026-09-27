import { useEffect, useMemo, useRef, useState } from "react";
import { intakeDraftIssues, type IntakeDraft, type IntakeDraftCalendarEvent, type IntakeDraftWorkItem, type IntakeIssue, type IntakeRecord } from "@machbar/shared";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { localizedErrorMessage, isStaleWriteConflict } from "../lib/errorMessage";
import { LoadingState } from "../components/AsyncStates";
import { issuesForPath, transitionCalendarAllDay, transitionWorkItemKind, workItemDepths } from "../lib/intakeDraft";
import { taskAvailabilityClock, taskAvailabilityForLocalDate } from "../lib/taskAvailability";

function IssueText({ issues, path }: { issues: IntakeIssue[]; path: (string | number)[] }) {
  return issuesForPath(issues, path).map((issue, index) => (
    <small className="field-error" role="alert" key={`${issue.code}-${index}`}>{issue.message}</small>
  ));
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const recordRef = useRef<IntakeRecord | null>(null);
  const revisionRef = useRef<number | null>(null);
  const latestDraftRef = useRef<IntakeDraft | null>(null);
  const cleanDraftSnapshotRef = useRef<string | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const debounceRef = useRef<number | null>(null);
  const conflictPendingRef = useRef(false);
  const applyingRef = useRef(false);
  const failedSnapshotRef = useRef<string | null>(null);
  const issues = useMemo(
    () => (draft ? intakeDraftIssues(draft, {
      memberIds: members.map((member) => member.id),
      paperlessAvailable: record?.paperlessAvailable ?? false,
      hasFiles: (record?.attachments.length ?? 0) > 0,
    }) : []),
    [draft, members, record],
  );
  const latestIssuesRef = useRef(issues);
  latestIssuesRef.current = issues;

  useEffect(() => {
    if (state.data) {
      recordRef.current = state.data;
      revisionRef.current = state.data.revision;
      setRecord(state.data);
      if (state.data.draft && (
        latestDraftRef.current === null ||
        conflictPendingRef.current ||
        JSON.stringify(latestDraftRef.current) === cleanDraftSnapshotRef.current
      )) {
        latestDraftRef.current = state.data.draft;
        cleanDraftSnapshotRef.current = JSON.stringify(state.data.draft);
        failedSnapshotRef.current = null;
        conflictPendingRef.current = false;
        setSaveError(null);
        setDraft(state.data.draft);
      }
    }
  }, [state.data]);

  const saveCurrentDraft = async (): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    const current = latestDraftRef.current;
    const revision = revisionRef.current;
    if (!current || revision === null || recordRef.current?.status !== "ready" || conflictPendingRef.current || latestIssuesRef.current.length) return false;
    if (JSON.stringify(current) === cleanDraftSnapshotRef.current) return true;
    if (JSON.stringify(current) === failedSnapshotRef.current) return false;
    const save = (async () => {
      while (latestDraftRef.current) {
        const nextDraft = latestDraftRef.current;
        const snapshot = JSON.stringify(nextDraft);
        if (snapshot === cleanDraftSnapshotRef.current) return true;
        if (latestIssuesRef.current.length || snapshot === failedSnapshotRef.current) return false;
        const expectedRevision = revisionRef.current;
        if (expectedRevision === null) return false;
        try {
          const nextRecord = await api.updateIntakeDraft(id, {
            expectedRevision,
            draft: nextDraft,
          });
          revisionRef.current = nextRecord.revision;
          cleanDraftSnapshotRef.current = snapshot;
          failedSnapshotRef.current = null;
          setSaveError(null);
          recordRef.current = nextRecord;
          setRecord({ ...nextRecord, draft: latestDraftRef.current });
        } catch (cause) {
          if (isStaleWriteConflict(cause)) {
            conflictPendingRef.current = true;
            setSaveError(null);
            state.reload();
          } else {
            failedSnapshotRef.current = snapshot;
            setSaveError(localizedErrorMessage(cause, strings));
          }
          return false;
        }
      }
      return true;
    })();
    savePromiseRef.current = save;
    try {
      return await save;
    } finally {
      savePromiseRef.current = null;
      if (
        !applyingRef.current &&
        !conflictPendingRef.current &&
        !latestIssuesRef.current.length &&
        latestDraftRef.current &&
        JSON.stringify(latestDraftRef.current) !== cleanDraftSnapshotRef.current &&
        JSON.stringify(latestDraftRef.current) !== failedSnapshotRef.current
      ) {
        if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(() => {
          debounceRef.current = null;
          void saveCurrentDraft();
        }, 1_000);
      }
    }
  };

  useEffect(() => {
    if (!draft || record?.status !== "ready" || issues.length || conflictPendingRef.current || JSON.stringify(draft) === cleanDraftSnapshotRef.current || JSON.stringify(draft) === failedSnapshotRef.current) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void saveCurrentDraft();
    }, 1_000);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    };
  }, [draft, id, record?.status, issues.length]);
  useEffect(() => {
    if (!record || !["queued", "analyzing", "applying"].includes(record.status)) return;
    const timer = window.setInterval(state.reload, 2_000);
    return () => window.clearInterval(timer);
  }, [record?.status, state.reload, version]);

  const workItemDepth = useMemo(
    () => (draft ? workItemDepths(draft.workItems) : []),
    [draft?.workItems],
  );
  if (state.loading && !record) return <LoadingState />;
  if (state.error && !record) {
    return <section className="card stack" role="alert"><h1>{strings.intakeExpired}</h1><p>{state.error}</p><Link className="btn" to="/today">{strings.toMachbar}</Link></section>;
  }
  if (!record) return null;

  const updateDraft = (next: IntakeDraft) => {
    if (applyingRef.current) return;
    if (JSON.stringify(next) !== failedSnapshotRef.current) {
      failedSnapshotRef.current = null;
      setSaveError(null);
    }
    latestDraftRef.current = next;
    setDraft(next);
    const nextRecord = { ...record, draft: next };
    recordRef.current = nextRecord;
    setRecord(nextRecord);
  };
  const retry = async () => {
    setBusy(true);
    try { setRecord(await api.retryIntake(id)); } finally { setBusy(false); }
  };
  const applyInitial = async () => {
    if (record.status !== "ready" || !draft || issues.length || applyingRef.current) return;
    applyingRef.current = true;
    setApplyError(null);
    setBusy(true);
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = null;
    try {
      if (savePromiseRef.current && !(await savePromiseRef.current)) return;
      if (JSON.stringify(latestDraftRef.current) !== cleanDraftSnapshotRef.current) {
        const saved = await saveCurrentDraft();
        if (!saved) return;
      }
      const latestDraft = latestDraftRef.current;
      const expectedRevision = revisionRef.current;
      if (!latestDraft || expectedRevision === null) return;
      const nextRecord = await api.applyIntake(id, { expectedRevision, draft: latestDraft });
      recordRef.current = nextRecord;
      revisionRef.current = nextRecord.revision;
      setRecord(nextRecord);
      setApplyError(null);
    }
    catch (cause) {
      if (isStaleWriteConflict(cause)) {
        conflictPendingRef.current = true;
        state.reload();
      } else {
        setApplyError(localizedErrorMessage(cause, strings));
      }
    } finally {
      applyingRef.current = false;
      setBusy(false);
    }
  };
  const retryApply = async () => {
    if (record.status !== "partially_applied" || applyingRef.current) return;
    applyingRef.current = true;
    setApplyError(null);
    setBusy(true);
    try {
      const nextRecord = await api.applyIntake(id, { expectedRevision: record.revision });
      recordRef.current = nextRecord;
      revisionRef.current = nextRecord.revision;
      setRecord(nextRecord);
      setApplyError(null);
    } catch (cause) {
      if (isStaleWriteConflict(cause)) {
        conflictPendingRef.current = true;
        state.reload();
      } else {
        setApplyError(localizedErrorMessage(cause, strings));
      }
    } finally {
      applyingRef.current = false;
      setBusy(false);
    }
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
      {record.status === "partially_applied" && record.error ? <p role="alert">{record.error.message}</p> : null}
      {record.status === "partially_applied" ? record.applyResults?.calendar.filter((result) => result.status === "failed").map((result) => (
        <p key={result.key} role="alert">{result.error?.message ?? strings.error}</p>
      )) : null}
      {record.applyResults?.work.map((item) => <Link key={item.key} to={item.role === "story" ? `/projects/${item.workItemId}` : `/tasks/${item.workItemId}`}>{item.key}</Link>)}
      {record.status === "partially_applied" && applyError ? <p role="alert">{applyError}</p> : null}
      {record.status === "partially_applied" ? <button className="btn btn-primary" disabled={busy} onClick={() => void retryApply()}>{strings.intakeRetryApply}</button> : null}
    </section>;
  }
  if (!draft) return <LoadingState />;
  return <section className="stack intake-review">
    <h1>{strings.intakeReady}</h1>
    <label className="field"><span>{strings.notes}</span><textarea value={draft.summary} onChange={(event) => updateDraft({ ...draft, summary: event.target.value })} /></label>
    {draft.warnings.length ? <section role="status"><h2>{strings.intakeWarnings}</h2><ul>{draft.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul></section> : null}
    <h2>{strings.intakeCalendar}</h2>
    {draft.calendarEvents.map((event, index) => <CalendarEditor key={event.key} event={event} index={index} issues={issues} onChange={(next) => updateDraft({ ...draft, calendarEvents: draft.calendarEvents.map((item, i) => i === index ? next : item) })} />)}
    <h2>{strings.intakeMachbar}</h2>
    {draft.workItems.map((item, index) => <WorkEditor key={item.key} item={item} index={index} depth={workItemDepth[index] ?? 0} onKindChange={(kind) => updateDraft({ ...draft, workItems: transitionWorkItemKind(draft.workItems, item.key, kind) })} members={members} issues={issues} onChange={(next) => {
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
    <div className="row"><button className="btn btn-primary" disabled={busy || issues.length > 0} onClick={() => void applyInitial()}>{strings.intakeApply}</button><button className="btn" disabled={busy} onClick={() => void discard()}>{strings.intakeDiscard}</button></div>
    {applyError ? <p role="alert">{applyError}</p> : null}
    {saveError ? <p role="alert">{saveError}</p> : null}
    {issues.length ? <p role="alert">{issues[0]?.message}</p> : null}
  </section>;
}

function CalendarEditor({ event, index, issues, onChange }: { event: IntakeDraftCalendarEvent; index: number; issues: IntakeIssue[]; onChange: (event: IntakeDraftCalendarEvent) => void }) {
  const strings = useStrings();
  const startPath = ["calendarEvents", index, event.allDay ? "startDate" : "startDateTime"];
  const endPath = ["calendarEvents", index, event.allDay ? "endDate" : "endDateTime"];
  return <article className="card stack"><label><input type="checkbox" checked={event.enabled} onChange={(e) => onChange({ ...event, enabled: e.target.checked })} /> {event.title}</label>
    <input value={event.title} onChange={(e) => onChange({ ...event, title: e.target.value })} />
    <label><input type="checkbox" checked={event.allDay} onChange={(e) => onChange(transitionCalendarAllDay(event, e.target.checked))} /> {strings.intakeCalendar}</label>
    <input aria-label="start" value={event.allDay ? event.startDate ?? "" : event.startDateTime ?? ""} onChange={(e) => onChange(event.allDay ? { ...event, startDate: e.target.value } : { ...event, startDateTime: e.target.value })} />
    <input aria-label="end" value={event.allDay ? event.endDate ?? "" : event.endDateTime ?? ""} onChange={(e) => onChange(event.allDay ? { ...event, endDate: e.target.value } : { ...event, endDateTime: e.target.value, durationAssumed: false })} />
    <IssueText issues={issues} path={startPath} />
    <IssueText issues={issues} path={endPath} />
    <IssueText issues={issues} path={["calendarEvents", index]} />
    {!event.allDay && !event.endDateTime ? <small className="text-muted">{strings.intakeTimedWarning}</small> : null}
    <input aria-label="location" value={event.location ?? ""} onChange={(e) => onChange({ ...event, location: e.target.value || null })} />
    <textarea aria-label="description" value={event.description ?? ""} onChange={(e) => onChange({ ...event, description: e.target.value || null })} />
    {event.durationAssumed ? <span className="badge">{strings.intakeAssumedDuration}</span> : null}
  </article>;
}

function WorkEditor({ item, index, depth, onKindChange, members, issues, onChange }: { item: IntakeDraftWorkItem; index: number; depth: number; onKindChange: (kind: IntakeDraftWorkItem["kind"]) => void; members: { id: number; name: string }[]; issues: IntakeIssue[]; onChange: (item: IntakeDraftWorkItem) => void }) {
  const strings = useStrings();
  const path = ["workItems", index];
  const currentClock = taskAvailabilityClock(item.notBeforeAt);
  const hasTime = currentClock !== null && currentClock !== "00:00";
  const updateAvailability = (date: string, time: string | null) => {
    if (!date) {
      onChange({ ...item, notBeforeDate: null, notBeforeAt: null });
      return;
    }
    const availability = taskAvailabilityForLocalDate(date, time);
    if (availability) onChange({ ...item, ...availability });
  };
  return <article className="card stack" style={{ marginInlineStart: `${Math.min(depth, 5)}rem` }}><label><input type="checkbox" checked={item.enabled} onChange={(e) => onChange({ ...item, enabled: e.target.checked })} /> {item.title}</label>
    <select value={item.kind} onChange={(e) => onKindChange(e.target.value as IntakeDraftWorkItem["kind"])}><option value="action">Action</option><option value="project">Project</option><option value="reference">Reference</option></select>
    <input value={item.title} onChange={(e) => onChange({ ...item, title: e.target.value })} />
    {item.kind !== "reference" ? <><select aria-label={strings.owner} value={item.ownerMemberId ?? ""} onChange={(e) => onChange({ ...item, ownerMemberId: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select><IssueText issues={issues} path={[...path, "ownerMemberId"]} /></> : null}
    <textarea aria-label={strings.notes} value={item.notes ?? ""} onChange={(e) => onChange({ ...item, notes: e.target.value || null })} />
    {item.kind !== "reference" ? <><label>{strings.due}<input value={item.dueDate ?? ""} onChange={(e) => onChange({ ...item, dueDate: e.target.value || null })} /></label><IssueText issues={issues} path={[...path, "dueDate"]} /></> : null}
    {item.kind === "action" ? <>
      <label>{strings.scheduled}<input value={item.scheduledDate ?? ""} onChange={(e) => onChange({ ...item, scheduledDate: e.target.value || null })} /></label><IssueText issues={issues} path={[...path, "scheduledDate"]} />
      <label>{strings.notBefore}<input type="date" value={item.notBeforeDate ?? ""} onChange={(e) => updateAvailability(e.target.value, hasTime ? currentClock : null)} /></label>
      <label><input type="checkbox" checked={hasTime} disabled={!item.notBeforeDate} onChange={(e) => updateAvailability(item.notBeforeDate ?? "", e.target.checked ? (currentClock && currentClock !== "00:00" ? currentClock : "08:00") : null)} /> {strings.availabilityCustomTime}</label>
      {hasTime ? <input aria-label={strings.availabilityCustomTime} type="time" value={currentClock ?? ""} onChange={(e) => updateAvailability(item.notBeforeDate ?? "", e.target.value || null)} /> : null}
      <IssueText issues={issues} path={[...path, "notBeforeDate"]} />
      <IssueText issues={issues} path={path} />
      <button type="button" className="btn" disabled={!item.notBeforeDate} onClick={() => updateAvailability("", null)}>{strings.clearNotBefore}</button>
      <label>{strings.reminder}<input value={item.reminderAt ?? ""} onChange={(e) => onChange({ ...item, reminderAt: e.target.value || null })} /></label>
      <IssueText issues={issues} path={[...path, "reminderAt"]} />
      <label><input type="checkbox" checked={item.needsClarification} onChange={(e) => onChange({ ...item, needsClarification: e.target.checked, reminderAt: e.target.checked ? null : item.reminderAt })} /> Klärung nötig</label>
    </> : null}
    <IssueText issues={issues} path={[...path, "parentKey"]} />
    <IssueText issues={issues} path={path} />
  </article>;
}
