import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { intakeDraftIssues, type IntakeDraft, type IntakeRecord } from "@machbar/shared";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { localizedErrorMessage, isStaleWriteConflict } from "../lib/errorMessage";
import { LoadingState } from "../components/AsyncStates";
import { IntakeProposalReview } from "./IntakeProposalReview";
import { type DateValidityChange } from "./IntakeReviewFields";

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
  const [invalidDateKeys, setInvalidDateKeys] = useState<Set<string>>(() => new Set());
  const onDateValidityChange = useCallback<DateValidityChange>((key, valid) => {
    setInvalidDateKeys((previous) => {
      if (previous.has(key) === !valid) return previous;
      const next = new Set(previous);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const activeDateKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const event of draft?.calendarEvents ?? []) {
      if (!event.allDay) {
        keys.add(`calendar:${event.key}:start`);
        keys.add(`calendar:${event.key}:end`);
      }
    }
    for (const item of draft?.workItems ?? []) {
      if (item.kind !== "reference") keys.add(`work:${item.key}:due`);
      if (item.kind === "action") {
        keys.add(`work:${item.key}:scheduled`);
        keys.add(`work:${item.key}:availability`);
        keys.add(`work:${item.key}:reminder-date`);
      }
    }
    return keys;
  }, [draft]);
  const hasInvalidInputs = [...invalidDateKeys].some((key) => activeDateKeys.has(key));
  useEffect(() => {
    setInvalidDateKeys((previous) => {
      if ([...previous].every((key) => activeDateKeys.has(key))) return previous;
      return new Set([...previous].filter((key) => activeDateKeys.has(key)));
    });
  }, [activeDateKeys]);
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

  const enabledProposalCount = (draft?.calendarEvents.filter((event) => event.enabled).length ?? 0) +
    (draft?.workItems.filter((item) => item.enabled).length ?? 0);
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
    if (record.status !== "ready" || !draft || busy || issues.length || hasInvalidInputs || applyingRef.current) return;
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
  if (record.status === "applying") return <section className="card stack"><h1>{strings.intakeApply}</h1><p>{strings.intakeApplying}</p>{!record.homeAssistant.workerOnline ? <p role="status">{strings.intakeOfflineHint}</p> : null}</section>;
  if (record.status === "applied" || record.status === "partially_applied") {
    return <section className="card stack"><h1>{record.status === "applied" ? strings.intakeApplied : strings.intakePartiallyApplied}</h1>
      {record.status === "partially_applied" && record.error ? <p role="alert">{record.error.message}</p> : null}
      {record.status === "partially_applied" ? record.applyResults?.calendar.filter((result) => result.status === "failed").map((result) => (
        <p key={result.key} role="alert">{record.draft?.calendarEvents.find((event) => event.key === result.key)?.title ?? result.key}: {result.error?.message ?? strings.error}</p>
      )) : null}
      {record.applyResults?.work.map((item) => <Link key={item.key} to={item.role === "story" ? `/projects/${item.workItemId}` : `/tasks/${item.workItemId}`}>{record.draft?.workItems.find((work) => work.key === item.key)?.title ?? item.key}</Link>)}
      {record.status === "partially_applied" && applyError ? <p role="alert">{applyError}</p> : null}
      {record.status === "partially_applied" ? <button className="btn btn-primary" disabled={busy} onClick={() => void retryApply()}>{strings.intakeRetryApply}</button> : null}
      <Link className="btn" to="/today">{strings.toMachbar}</Link>
    </section>;
  }
  if (!draft) return <LoadingState />;
  return (
    <section className="stack intake-review">
      <IntakeProposalReview
        draft={draft}
        members={members}
        issues={issues}
        invalidDateKeys={invalidDateKeys}
        onDateValidityChange={onDateValidityChange}
        onChange={updateDraft}
      />
      {applyError ? <p role="alert">{applyError}</p> : null}
      {saveError ? <p role="alert">{saveError}</p> : null}
      <div className="intake-approval-bar">
        <button
          type="button"
          className="btn btn-primary intake-approval-button"
          disabled={busy || issues.length > 0 || hasInvalidInputs}
          onClick={() => void applyInitial()}
        >
          {strings.intakeApplyCount(enabledProposalCount)}
        </button>
        <button
          type="button"
          className="btn intake-discard-button"
          disabled={busy}
          onClick={() => void discard()}
        >
          {strings.intakeDiscard}
        </button>
      </div>
    </section>
  );
}
