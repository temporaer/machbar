import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  intakeDraftIssues,
  intakeErrorIssues,
  intakeSelectedDraftIssues,
  INTAKE_TIMEZONE,
  prepareIncompleteIntakeDraft,
  type IntakeDraft,
  type IntakeDraftWorkItem,
  type IntakeOmission,
  type IntakeRecord,
} from "@machbar/shared";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, apiUrl } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import {
  localizedApiErrorMessage,
  localizedErrorMessage,
  isStaleWriteConflict,
} from "../lib/errorMessage";
import { LoadingState } from "../components/AsyncStates";
import { BottomSheet } from "../components/BottomSheet";
import { IntakeDiagnosticLink } from "../components/IntakeDiagnosticLink";
import { WorkRefinementReview } from "../components/WorkRefinementReview";
import { IntakeProposalReview } from "./IntakeProposalReview";
import { type DateValidityChange } from "./IntakeReviewFields";

function intakeIssuePath(path: readonly (string | number)[]): string {
  return path.reduce<string>((result, segment) =>
    typeof segment === "number"
      ? `${result}[${segment}]`
      : result
        ? `${result}.${segment}`
        : segment, "");
}

function intakeFailureExplanation(
  record: IntakeRecord,
  strings: ReturnType<typeof useStrings>,
): string {
  switch (record.error?.code) {
    case "intake_plan_invalid":
      return strings.intakeErrorValidation;
    case "ai_task_invalid_response":
      return strings.intakeErrorNormalization;
    default:
      return strings.intakeErrorProvider;
  }
}

function omissionSummary(
  omission: IntakeOmission,
  draft: IntakeDraft,
  strings: ReturnType<typeof useStrings>,
): string {
  const itemIndex = omission.path[0] === "workItems" && typeof omission.path[1] === "number"
    ? omission.path[1]
    : null;
  const item = itemIndex === null ? null : draft.workItems[itemIndex];
  const title = item?.title.trim() || strings.intakeMachbar;
  switch (omission.code) {
    case "invalid_date":
      return strings.intakeOmissionInvalidDate(title);
    case "invalid_datetime":
      return strings.intakeOmissionInvalidDateTime(title);
    case "ambiguous_datetime":
      return strings.intakeOmissionAmbiguousDateTime(title);
    case "nonexistent_datetime":
      return strings.intakeOmissionNonexistentDateTime(title);
    case "invalid_reminder_time":
      return strings.intakeOmissionInvalidReminderTime(title);
    case "invalid_reminder_timezone":
      return strings.intakeOmissionInvalidReminderTimezone(title);
    case "deadline_relative_without_due":
      return strings.intakeOmissionRelativeReminderNoDeadline(title);
    case "not_before_pair":
    case "not_before_date_mismatch":
      return strings.intakeOmissionInvalidAvailability(title);
    case "owner_not_member":
      return strings.intakeOmissionInvalidOwner(title);
  }
}

function acceptsIntakeRecord(
  current: IntakeRecord | null,
  incoming: IntakeRecord,
): boolean {
  if (!current) return true;
  if (incoming.revision > current.revision) return true;
  if (incoming.revision < current.revision) return false;
  if (incoming.status === current.status) return true;
  // `analyzing` is derived from the leased HA request and does not change
  // the intake job revision.
  return current.status === "queued" && incoming.status === "analyzing";
}

function intakeDateKeys(
  draft: IntakeDraft | null,
  enabledOnly: boolean,
  reminderRowIds: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const keys = new Set<string>();
  for (const event of draft?.calendarEvents ?? []) {
    if (enabledOnly && !event.enabled) continue;
    if (!event.allDay) {
      keys.add(`calendar:${event.key}:start`);
      keys.add(`calendar:${event.key}:end`);
    }
  }
  for (const item of draft?.workItems ?? []) {
    if (enabledOnly && !item.enabled) continue;
    if (item.kind !== "reference") {
      keys.add(`work:${item.key}:due`);
      keys.add(`work:${item.key}:scheduled`);
    }
    if (item.kind === "action") {
      keys.add(`work:${item.key}:availability`);
      if (item.reminders.length === 0) {
        keys.add(`work:${item.key}:reminder-date`);
      } else {
        item.reminders.forEach((_, index) => {
          const rowId = reminderRowIds.get(item.key)?.[index] ?? String(index);
          keys.add(`work:${item.key}:reminder-date-${rowId}`);
        });
      }
    }
  }
  return keys;
}

export function IntakeReviewPage() {
  const { id = "" } = useParams();
  const strings = useStrings();
  const navigate = useNavigate();
  const { members, membersLoading } = useIdentity();
  const { version } = useRefresh();
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || INTAKE_TIMEZONE,
    [],
  );
  const state = useAsync(() => api.getIntake(id), [id]);
  const [record, setRecord] = useState(state.data);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [retryHint, setRetryHint] = useState("");
  const [changeRequestOpen, setChangeRequestOpen] = useState(false);
  const [changeRequest, setChangeRequest] = useState("");
  const [invalidDateKeys, setInvalidDateKeys] = useState<Set<string>>(() => new Set());
  const reminderRowIdsRef = useRef<Map<string, string[]>>(new Map());
  const nextReminderRowIdRef = useRef(0);
  const reminderRowIds = useMemo(() => {
    const rows = new Map<string, string[]>();
    const activeItemKeys = new Set(
      (draft?.workItems ?? [])
        .filter((item) => item.kind === "action")
        .map((item) => item.key),
    );
    for (const key of reminderRowIdsRef.current.keys()) {
      if (!activeItemKeys.has(key)) reminderRowIdsRef.current.delete(key);
    }
    for (const item of draft?.workItems ?? []) {
      if (item.kind !== "action") continue;
      const ids = reminderRowIdsRef.current.get(item.key) ?? [];
      while (ids.length < item.reminders.length) {
        ids.push(`row-${nextReminderRowIdRef.current++}`);
      }
      if (ids.length > item.reminders.length) ids.length = item.reminders.length;
      reminderRowIdsRef.current.set(item.key, ids);
      rows.set(item.key, ids);
    }
    return rows;
  }, [draft]);
  const createReminderRowId = useCallback(
    () => `row-${nextReminderRowIdRef.current++}`,
    [],
  );
  const onDateValidityChange = useCallback<DateValidityChange>((key, valid) => {
    setInvalidDateKeys((previous) => {
      if (previous.has(key) === !valid) return previous;
      const next = new Set(previous);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const dateKeys = useMemo(() => intakeDateKeys(draft, false, reminderRowIds), [draft, reminderRowIds]);
  const activeDateKeys = useMemo(() => intakeDateKeys(draft, true, reminderRowIds), [draft, reminderRowIds]);
  const hasInvalidInputs = [...invalidDateKeys].some((key) => activeDateKeys.has(key));
  useEffect(() => {
    setInvalidDateKeys((previous) => {
      const next = new Set([...previous].filter((key) => dateKeys.has(key)));
      if (next.size === previous.size && [...next].every((key) => previous.has(key))) return previous;
      return next;
    });
  }, [dateKeys]);
  const recordRef = useRef<IntakeRecord | null>(null);
  const revisionRef = useRef<number | null>(null);
  const latestDraftRef = useRef<IntakeDraft | null>(null);
  const cleanDraftSnapshotRef = useRef<string | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const debounceRef = useRef<number | null>(null);
  const retryInFlightRef = useRef(false);
  const retryHintDirtyRef = useRef(false);
  const conflictPendingRef = useRef(false);
  const applyingRef = useRef(false);
  const failedSnapshotRef = useRef<string | null>(null);
  const mutationBaselineRevisionRef = useRef<number | null>(null);
  const issues = useMemo(
    () => (draft ? intakeDraftIssues(draft, {
      memberIds: members.map((member) => member.id),
      paperlessAvailable: record?.paperlessAvailable ?? false,
      hasFiles: (record?.attachments.length ?? 0) > 0,
    }) : []),
    [draft, members, record],
  );
  const selectedIssues = useMemo(
    () => (draft ? intakeSelectedDraftIssues(draft, {
      memberIds: members.map((member) => member.id),
      paperlessAvailable: record?.paperlessAvailable ?? false,
      hasFiles: (record?.attachments.length ?? 0) > 0,
    }) : []),
    [draft, members, record],
  );
  const validationOptions = useMemo(() => ({
    memberIds: members.map((member) => member.id),
    paperlessAvailable: record?.paperlessAvailable ?? false,
    hasFiles: (record?.attachments.length ?? 0) > 0,
    timezone,
  }), [members, record, timezone]);
  const incompletePreview = useMemo(
    () => (draft ? prepareIncompleteIntakeDraft(draft, validationOptions) : null),
    [draft, validationOptions],
  );
  const canAcceptIncomplete = Boolean(
    draft &&
    !membersLoading &&
    !hasInvalidInputs &&
    selectedIssues.length > 0 &&
    incompletePreview &&
    (incompletePreview.omissions.length > 0 || incompletePreview.normalizedTimestamps.length > 0) &&
    incompletePreview.blockingIssues.length === 0,
  );
  const omissionSummaries = useMemo(
    () => incompletePreview && draft
      ? incompletePreview.omissions.map((item) => omissionSummary(item, draft, strings))
      : [],
    [draft, incompletePreview, strings],
  );
  const inferredTimezones = useMemo(
    () => incompletePreview
      ? [...new Set(
        incompletePreview.normalizedTimestamps
          .map((item) => item.timezone)
          .filter((item): item is string => item !== null),
      )]
      : [],
    [incompletePreview],
  );
  const normalizedSecondsCount = useMemo(
    () => incompletePreview?.normalizedTimestamps.filter((item) => item.secondsAdded).length ?? 0,
    [incompletePreview],
  );
  const latestIssuesRef = useRef(issues);
  latestIssuesRef.current = issues;

  useEffect(() => {
    if (state.data) {
      if (!acceptsIntakeRecord(recordRef.current, state.data)) return;
      if (
        mutationBaselineRevisionRef.current !== null &&
        (retryInFlightRef.current || applyingRef.current) &&
        state.data.revision <= mutationBaselineRevisionRef.current
      ) return;
      recordRef.current = state.data;
      revisionRef.current = state.data.revision;
      setRecord(state.data);
      if ((state.data.status === "analysis_failed" || state.data.status === "ready") && !retryHintDirtyRef.current) {
        setRetryHint(state.data.retryHint ?? "");
      }
      if (state.data.draft && (
        latestDraftRef.current === null ||
        conflictPendingRef.current ||
        JSON.stringify(latestDraftRef.current) === cleanDraftSnapshotRef.current
      )) {
        latestDraftRef.current = state.data.draft;
        cleanDraftSnapshotRef.current = JSON.stringify(state.data.draft);
        failedSnapshotRef.current = null;
        conflictPendingRef.current = false;
        if (!retryInFlightRef.current) setSaveError(null);
        setDraft(state.data.draft);
      }
    }
  }, [state.data]);

  const saveCurrentDraft = async (): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    const current = latestDraftRef.current;
    const revision = revisionRef.current;
    if (!current || revision === null || recordRef.current?.status !== "ready" || conflictPendingRef.current) return false;
    if (JSON.stringify(current) === cleanDraftSnapshotRef.current) return true;
    if (JSON.stringify(current) === failedSnapshotRef.current) return false;
    const save = (async () => {
      while (latestDraftRef.current) {
        const nextDraft = latestDraftRef.current;
        const snapshot = JSON.stringify(nextDraft);
        if (snapshot === cleanDraftSnapshotRef.current) return true;
        if (snapshot === failedSnapshotRef.current) return false;
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
    if (!draft || record?.status !== "ready" || conflictPendingRef.current || JSON.stringify(draft) === cleanDraftSnapshotRef.current || JSON.stringify(draft) === failedSnapshotRef.current) return;
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
  const diagnosticHref = apiUrl(`/intake/${encodeURIComponent(id)}`);

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
  const updateReminderDraft = (
    item: IntakeDraftWorkItem,
    rowIds: readonly string[],
  ) => {
    reminderRowIdsRef.current.set(item.key, [...rowIds]);
    updateDraft({
      ...draft!,
      workItems: draft!.workItems.map((current) =>
        current.key === item.key ? item : current),
    });
  };
  const retry = async (requestedChanges?: string): Promise<boolean> => {
    if (retryInFlightRef.current || applyingRef.current || busy) return false;
    retryInFlightRef.current = true;
    mutationBaselineRevisionRef.current = revisionRef.current;
    setBusy(true);
    setSaveError(null);
    try {
      if (record.status === "ready") {
        if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        if (savePromiseRef.current && !(await savePromiseRef.current)) {
          if (conflictPendingRef.current) {
            setSaveError(localizedApiErrorMessage("stale_write_conflict", undefined, strings));
          }
          return false;
        }
        if (JSON.stringify(latestDraftRef.current) !== cleanDraftSnapshotRef.current) {
          if (!(await saveCurrentDraft())) {
            if (conflictPendingRef.current) {
              setSaveError(localizedApiErrorMessage("stale_write_conflict", undefined, strings));
            }
            return false;
          }
        }
        if (conflictPendingRef.current) {
          setSaveError(localizedApiErrorMessage("stale_write_conflict", undefined, strings));
          return false;
        }
      }
      const nextRecord = await api.retryIntake(
        id,
        requestedChanges ?? (retryHintDirtyRef.current ? retryHint : undefined),
      );
      recordRef.current = nextRecord;
      revisionRef.current = nextRecord.revision;
      conflictPendingRef.current = false;
      if (nextRecord.status === "ready" && nextRecord.draft) {
        reminderRowIdsRef.current.clear();
        latestDraftRef.current = nextRecord.draft;
        cleanDraftSnapshotRef.current = JSON.stringify(nextRecord.draft);
        failedSnapshotRef.current = null;
        setDraft(nextRecord.draft);
      } else {
        setDraft(nextRecord.draft ?? latestDraftRef.current);
      }
      setRecord(nextRecord);
      setRetryHint(nextRecord.retryHint ?? "");
      retryHintDirtyRef.current = false;
      return true;
    } catch (cause) {
      setSaveError(localizedErrorMessage(cause, strings));
      return false;
    } finally {
      retryInFlightRef.current = false;
      mutationBaselineRevisionRef.current = null;
      setBusy(false);
    }
  };
  const applyInitial = async (acceptIncomplete = false) => {
    if (record.status !== "ready" || !draft || busy || hasInvalidInputs || applyingRef.current || retryInFlightRef.current) return;
    if (!acceptIncomplete && selectedIssues.length > 0) return;
    if (acceptIncomplete && !canAcceptIncomplete) return;
    applyingRef.current = true;
    mutationBaselineRevisionRef.current = revisionRef.current;
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
      if (acceptIncomplete) {
        const latestPreview = prepareIncompleteIntakeDraft(latestDraft, validationOptions);
        if (
          latestPreview.omissions.length === 0 &&
          latestPreview.normalizedTimestamps.length === 0
        ) return;
        if (latestPreview.blockingIssues.length > 0) return;
      } else if (intakeSelectedDraftIssues(latestDraft, validationOptions).length > 0) {
        return;
      }
      const nextRecord = await api.applyIntake(id, {
        expectedRevision,
        draft: latestDraft,
        timezone,
        ...(acceptIncomplete ? { acceptIncomplete: true } : {}),
      });
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
        if (record.breakdown) {
          // Failed breakdown transactions release their claim and advance the
          // revision. Refresh before enabling edits so the next save is current.
          try {
            const recovered = await api.getIntake(id);
            recordRef.current = recovered;
            revisionRef.current = recovered.revision;
            setRecord(recovered);
          } catch {
            state.reload();
          }
        }
      }
    } finally {
      applyingRef.current = false;
      mutationBaselineRevisionRef.current = null;
      setBusy(false);
    }
  };
  const retryApply = async () => {
    if (record.status !== "partially_applied" || applyingRef.current) return;
    applyingRef.current = true;
    mutationBaselineRevisionRef.current = revisionRef.current;
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
      mutationBaselineRevisionRef.current = null;
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try { await api.deleteIntake(id); navigate("/today"); } finally { setBusy(false); }
  };
  if (record.status === "analysis_failed" && !draft && !record.refinement?.proposal) {
    const validationIssues = record.error ? intakeErrorIssues(record.error) : [];
    return (
      <section className="card stack" role="alert">
        <h1>{strings.intakeAnalysisFailed}</h1>
        <p>{intakeFailureExplanation(record, strings)}</p>
        {validationIssues.length ? (
          <div className="stack">
            <h2>{strings.intakeValidationProblems}</h2>
            {validationIssues.map((issue, index) => (
              <p key={`${intakeIssuePath(issue.path)}-${issue.code}-${index}`}>
                <code>{intakeIssuePath(issue.path)}</code>: {issue.message}
              </p>
            ))}
          </div>
        ) : null}
        <label className="stack">
          <span>{strings.intakeRetryHintLabel}</span>
          <textarea
            rows={3}
            value={retryHint}
            placeholder={strings.intakeRetryHintPlaceholder}
            disabled={busy}
            onChange={(event) => {
              retryHintDirtyRef.current = true;
              setRetryHint(event.target.value);
            }}
          />
          <small>{strings.intakeRetryHintHelp}</small>
        </label>
        {record.error ? (
          <details>
            <summary>{strings.intakeTechnicalDetails}</summary>
            <pre>{JSON.stringify({
              code: record.error.code,
              details: record.error.details,
            }, null, 2)}</pre>
          </details>
        ) : null}
        <IntakeDiagnosticLink href={diagnosticHref} />
        <p>{record.error?.message ?? strings.intakeAnalysisFailed}</p>
        {saveError ? <p role="alert">{saveError}</p> : null}
        <button className="btn btn-primary" disabled={busy} onClick={() => void retry()}>{strings.intakeRetry}</button>
      </section>
    );
  }
  if (record.status === "queued" && !draft) return <section className="card stack"><h1>{strings.intakeProcess}</h1><p>{strings.intakeQueued}</p>{!record.homeAssistant.workerOnline ? <p role="status">{strings.intakeOfflineHint}</p> : null}</section>;
  if (record.status === "analyzing" && !draft) return <section className="card stack"><h1>{strings.intakeProcess}</h1><p>{strings.intakeAnalyzing}</p></section>;
  if (record.status === "applying") return <section className="card stack"><h1>{strings.intakeApply}</h1><p>{strings.intakeApplying}</p>{!record.homeAssistant.workerOnline ? <p role="status">{strings.intakeOfflineHint}</p> : null}</section>;
  if (record.status === "applied" || record.status === "partially_applied") {
    const failedCalendarResults = record.applyResults?.calendar.filter((result) => result.status === "failed") ?? [];
    const hasPartialError = record.status === "partially_applied" && (
      Boolean(record.error) || failedCalendarResults.length > 0 || Boolean(applyError)
    );
    return <section className="card stack"><h1>{record.status === "applied" ? strings.intakeApplied : strings.intakePartiallyApplied}</h1>
      {hasPartialError ? (
        <div className="stack intake-error-group">
          {record.error ? <p role="alert">{record.error.message}</p> : null}
          {failedCalendarResults.map((result) => (
            <p key={result.key} role="alert">{record.draft?.calendarEvents.find((event) => event.key === result.key)?.title ?? result.key}: {result.error?.message ?? strings.error}</p>
          ))}
          {applyError ? <p role="alert">{applyError}</p> : null}
          <IntakeDiagnosticLink href={diagnosticHref} />
        </div>
      ) : null}
      {record.applyResults?.work.map((item) => <Link key={item.key} to={item.role === "story" ? `/projects/${item.workItemId}` : `/tasks/${item.workItemId}`}>{record.draft?.workItems.find((work) => work.key === item.key)?.title ?? item.key}</Link>)}
      {record.status === "partially_applied" ? <button className="btn btn-primary" disabled={busy} onClick={() => void retryApply()}>{strings.intakeRetryApply}</button> : null}
      <Link className="btn" to="/today">{strings.toMachbar}</Link>
    </section>;
  }
  if (record.refinement?.proposal && ["ready", "analysis_failed"].includes(record.status)) {
    return <WorkRefinementReview record={record} onChange={(next) => { recordRef.current = next; revisionRef.current = next.revision; setRecord(next); }} />;
  }
  if (!draft) return <LoadingState />;
  return (
    <section className="stack intake-review">
      {record.status === "queued" || record.status === "analyzing" ? (
        <section className="card stack" role="status">
          <h2>{strings.intakeProcess}</h2>
          <p>{record.status === "queued" ? strings.intakeQueued : strings.intakeAnalyzing}</p>
          {record.status === "queued" && !record.homeAssistant.workerOnline
            ? <p>{strings.intakeOfflineHint}</p>
            : null}
        </section>
      ) : null}
      {record.status === "analysis_failed" ? (
        <section className="card stack" role="alert">
          <h2>{strings.intakeAnalysisFailed}</h2>
          <p>{intakeFailureExplanation(record, strings)}</p>
          {record.error ? (
            (record.error.details?.issues ?? []).map((issue, index) => (
              <p key={`${intakeIssuePath(issue.path)}-${issue.code}-${index}`}>
                <code>{intakeIssuePath(issue.path)}</code>: {issue.message}
              </p>
            ))
          ) : null}
          <label className="stack">
            <span>{strings.intakeRetryHintLabel}</span>
            <textarea
              rows={3}
              value={retryHint}
              placeholder={strings.intakeRetryHintPlaceholder}
              disabled={busy}
              onChange={(event) => {
                retryHintDirtyRef.current = true;
                setRetryHint(event.target.value);
              }}
            />
            <small>{strings.intakeRetryHintHelp}</small>
          </label>
          <IntakeDiagnosticLink href={diagnosticHref} />
          <button className="btn btn-primary" disabled={busy} onClick={() => void retry()}>
            {strings.intakeRetry}
          </button>
        </section>
      ) : null}
      <fieldset disabled={busy || record.status !== "ready"} className="intake-review-fields">
        <IntakeProposalReview
          draft={draft}
          members={members}
          issues={issues}
          invalidDateKeys={invalidDateKeys}
          reminderRowIds={reminderRowIds}
          createReminderRowId={createReminderRowId}
          onDateValidityChange={onDateValidityChange}
          onChange={updateDraft}
          onReminderChange={updateReminderDraft}
          diagnosticHref={diagnosticHref}
          breakdown={Boolean(record.breakdown)}
          existingChildren={record.breakdown?.existingChildren ?? []}
        />
      </fieldset>
      {applyError ? (
        <div className="stack intake-error-group">
          <p role="alert">{applyError}</p>
          <IntakeDiagnosticLink href={diagnosticHref} />
        </div>
      ) : null}
      {saveError ? (
        <div className="stack intake-error-group">
          <p role="alert">{saveError}</p>
          <IntakeDiagnosticLink href={diagnosticHref} />
        </div>
      ) : null}
      {issues.length > 0 ? (
        <section className="card stack" role="alert">
          <p>{strings.intakeProposalNeedsFixing}</p>
          <p>{strings.intakeProposalReplacementWarning}</p>
          <label className="stack">
            <span>{strings.intakeRetryHintLabel}</span>
            <textarea
              rows={3}
              value={retryHint}
              placeholder={strings.intakeRetryHintPlaceholder}
              disabled={busy}
              onChange={(event) => {
                retryHintDirtyRef.current = true;
                setRetryHint(event.target.value);
              }}
            />
            <small>{strings.intakeRetryHintHelp}</small>
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => void retry()}>
            {strings.intakeRetry}
          </button>
          <IntakeDiagnosticLink href={diagnosticHref} />
        </section>
      ) : null}
      {canAcceptIncomplete ? (
        <div className="intake-approval-summary stack">
          {omissionSummaries.length > 0 ? (
            <>
              <strong>{strings.intakeOmissions}</strong>
              <ul>
                {omissionSummaries.map((summary, index) => <li key={`${summary}-${index}`}>{summary}</li>)}
              </ul>
            </>
          ) : null}
          {normalizedSecondsCount > 0 ? (
            <small>{strings.intakeTimestampSecondsAdded(normalizedSecondsCount)}</small>
          ) : null}
          {inferredTimezones.map((inferredTimezone) => (
            <small key={inferredTimezone}>
              {strings.intakeTimestampTimezoneAdded(inferredTimezone)}
            </small>
          ))}
        </div>
      ) : null}
      <div className="intake-approval-bar">
        <div className="intake-approval-actions">
          {canAcceptIncomplete ? (
            <button
              type="button"
              className="btn btn-primary intake-approval-button"
              disabled={busy || record.status !== "ready" || hasInvalidInputs}
              onClick={() => void applyInitial(true)}
            >
              {strings.intakeAcceptIncomplete}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary intake-approval-button"
              disabled={busy || record.status !== "ready" || selectedIssues.length > 0 || hasInvalidInputs}
              onClick={() => void applyInitial(false)}
            >
              {record.breakdown ? strings.taskBreakdownApply : strings.intakeApplyCount(enabledProposalCount)}
            </button>
          )}
          <button
            type="button"
            className="btn intake-discard-button"
            disabled={busy || record.status !== "ready"}
            onClick={() => void discard()}
          >
            {strings.intakeDiscard}
          </button>
          {record.status === "ready" ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setChangeRequest(retryHintDirtyRef.current ? retryHint : record.retryHint ?? "");
                setChangeRequestOpen(true);
              }}
            >
              {strings.intakeRequestChanges}
            </button>
          ) : null}
        </div>
      </div>
      {changeRequestOpen && record.status === "ready" ? (
        <BottomSheet
          title={strings.intakeRequestChanges}
          onClose={() => setChangeRequestOpen(false)}
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void retry(changeRequest).then((succeeded) => {
                if (succeeded) setChangeRequestOpen(false);
              });
            }}
          >
            <label className="stack">
              <span>{strings.intakeRequestedChangesLabel}</span>
              <textarea
                rows={4}
                value={changeRequest}
                disabled={busy}
                onChange={(event) => setChangeRequest(event.target.value)}
              />
            </label>
            <div className="intake-approval-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setChangeRequestOpen(false)}
              >
                {strings.cancel}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {strings.intakeReprocess}
              </button>
            </div>
          </form>
        </BottomSheet>
      ) : null}
    </section>
  );
}
