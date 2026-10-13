import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { intakeErrorIssues, type IntakeRecord, type WorkRefinementChange } from "@machbar/shared";
import { api } from "../lib/api";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { calendarDateForInstant, householdCalendarDateTimeToRevisitAt, localTimeForInstant, type TaskReminderInput } from "@machbar/shared";
import { useHouseholdTimezone } from "../lib/householdTimezone";
import { TaskRemindersEditor, type TaskRemindersEditorHandle } from "./TaskRemindersEditor";
import {
  projectActivationPromptFromError,
  projectActivationResolutionFromPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";

const labels = {
  update_task: "refinementTitle", update_project: "refinementTitle", convert_task_to_project: "refinementConvert", create_child: "refinementCreate",
  move_task: "refinementMove", add_dependency: "refinementDependency", update_wait: "refinementWait",
  resolve_wait: "refinementResolveWait", cancel_task: "refinementCancel",
  update_project_outcome: "refinementOutcome", advisory: "refinementAdvisory",
} as const;

type RefinementProposal = NonNullable<
  NonNullable<IntakeRecord["refinement"]>["proposal"]
>;

type ServerProposalBaseline = {
  recordId: string;
  revision: number;
  proposal: RefinementProposal | null;
  signature: string;
};

function semanticSignature(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => semanticSignature(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${semanticSignature(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function WorkRefinementReview({ record, onChange }: { record: IntakeRecord; onChange: (record: IntakeRecord) => void }) {
  const strings = useStrings();
  const { members } = useIdentity();
  const { timezone: householdTimezone } = useHouseholdTimezone();
  const reminderEditors = useRef(new Map<number, TaskRemindersEditorHandle>());
  const navigate = useNavigate();
  const refinement = record.refinement;
  const serverProposal = refinement?.proposal ?? null;
  const [proposalDraft, setProposalDraft] = useState<RefinementProposal | null>(serverProposal);
  const proposalDraftRef = useRef<RefinementProposal | null>(serverProposal);
  const draftGenerationRef = useRef(0);
  const serverBaselineRef = useRef<ServerProposalBaseline>({
    recordId: record.id,
    revision: record.revision,
    proposal: serverProposal,
    signature: semanticSignature(serverProposal),
  });
  const allowServerReplacementRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const proposal = serverBaselineRef.current.recordId === record.id
    ? (proposalDraft ?? refinement?.proposal)
    : serverProposal;
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<"save" | "apply" | "regenerate" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revisitDrafts, setRevisitDrafts] = useState<Record<number, { date: string; time: string }>>({});
  const [pendingReminderEditors, setPendingReminderEditors] = useState<Record<number, boolean>>({});
  const [editorResetGeneration, setEditorResetGeneration] = useState(0);
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);
  const incomingProposalSignature = semanticSignature(serverProposal);
  const editorLocked = busy && (operation === "apply" || operation === "regenerate" || operation === "discard");
  const latestObservedRevisionRef = useRef(record.revision);

  const setDraft = useCallback((next: RefinementProposal | null, userEdit = true) => {
    proposalDraftRef.current = next;
    if (userEdit) draftGenerationRef.current += 1;
    setProposalDraft(next);
    if (userEdit) setActivationPrompt(null);
  }, []);

  const commitReminderDrafts = (): boolean => {
    const current = proposalDraftRef.current;
    if (!current) return false;
    if (Object.values(revisitDrafts).some(({ date, time }) => date !== "" && !householdCalendarDateTimeToRevisitAt(date, time, householdTimezone))) {
      setError(strings.refinementPlanningIncomplete);
      return false;
    }
    const changes = current.changes.map((change, index) => {
      const editor = reminderEditors.current.get(index);
      if (!editor?.hasOpenEditor()) return change;
      const reminders = editor.getCommitValue();
      if (!reminders) return null;
      return { ...change, reminders } as WorkRefinementChange;
    });
    if (changes.some((change) => change === null)) {
      setError(strings.refinementPlanningIncomplete);
      return false;
    }
    if (changes.some((change, index) => change !== current.changes[index])) {
      setDraft({ ...current, changes: changes as WorkRefinementChange[] });
    }
    return true;
  };

  useEffect(() => {
    const incomingBaseline: ServerProposalBaseline = {
      recordId: record.id,
      revision: record.revision,
      proposal: serverProposal,
      signature: incomingProposalSignature,
    };
    const previous = serverBaselineRef.current;

    if (incomingProposalSignature !== previous.signature) setActivationPrompt(null);

    if (previous.recordId !== record.id) {
      serverBaselineRef.current = incomingBaseline;
      latestObservedRevisionRef.current = record.revision;
      setDraft(serverProposal, false);
      setRevisitDrafts({});
      setPendingReminderEditors({});
      setEditorResetGeneration((generation) => generation + 1);
      setConflict(false);
      setAnswer("");
      setError(null);
      return;
    }

    latestObservedRevisionRef.current = Math.max(latestObservedRevisionRef.current, record.revision);
    if (allowServerReplacementRef.current) {
      allowServerReplacementRef.current = false;
      serverBaselineRef.current = incomingBaseline;
      setDraft(serverProposal, false);
      setRevisitDrafts({});
      setPendingReminderEditors({});
      setEditorResetGeneration((generation) => generation + 1);
      setConflict(false);
      return;
    }

    if (
      record.revision < previous.revision ||
      (record.revision === previous.revision &&
        incomingProposalSignature === previous.signature)
    ) {
      return;
    }

    const currentDraftSignature = semanticSignature(proposalDraftRef.current);
    const draftIsDirty = currentDraftSignature !== previous.signature ||
      Object.keys(revisitDrafts).length > 0 ||
      Object.values(pendingReminderEditors).some(Boolean);
    serverBaselineRef.current = incomingBaseline;

    if (!draftIsDirty) {
      setDraft(serverProposal, false);
      if (incomingProposalSignature !== previous.signature) {
        setRevisitDrafts({});
        setEditorResetGeneration((generation) => generation + 1);
      }
      setConflict(false);
      return;
    }

    // A revision can advance while the server proposal remains equivalent.
    // That is not a content conflict, and the local draft must stay intact.
    if (incomingProposalSignature === previous.signature) return;

    if (incomingProposalSignature === currentDraftSignature) {
      setDraft(serverProposal, false);
      setConflict(false);
    } else {
      setConflict(true);
    }
  }, [
    incomingProposalSignature,
    record.id,
    record.revision,
    revisitDrafts,
    pendingReminderEditors,
    setDraft,
  ]);

  if (!refinement || !proposal) return null;
  const update = (index: number, patch: Partial<WorkRefinementChange>) => {
    const changes = proposal.changes.map((item, i) => i === index ? { ...item, ...patch } as WorkRefinementChange : item);
    setDraft({ ...proposal, changes });
    setError(null);
  };

  const acknowledgeServerProposal = (
    next: IntakeRecord,
    generationAtRequest: number,
    fallbackProposal: RefinementProposal,
    options: { allowReplacement?: boolean } = {},
  ) => {
    if (next.id === record.id && next.revision < latestObservedRevisionRef.current) {
      setConflict(true);
      return false;
    }
    const nextProposal = next.refinement?.proposal ?? fallbackProposal;
    serverBaselineRef.current = {
      recordId: next.id,
      revision: next.revision,
      proposal: nextProposal,
      signature: semanticSignature(nextProposal),
    };
    if (options.allowReplacement) {
      allowServerReplacementRef.current = true;
    } else if (draftGenerationRef.current === generationAtRequest) {
      setDraft(nextProposal, false);
    }
    setConflict(false);
    onChange(next);
    return true;
  };

  const persistLatestProposal = async (): Promise<IntakeRecord | null> => {
    let latestRecord = record;
    while (true) {
      const currentProposal = proposalDraftRef.current;
      if (!currentProposal) return null;
      const generationAtRequest = draftGenerationRef.current;
      latestRecord = await api.updateWorkRefinement(latestRecord.id, {
        expectedRevision: latestRecord.revision,
        proposal: currentProposal,
      });
      const acknowledged = acknowledgeServerProposal(
        latestRecord,
        generationAtRequest,
        currentProposal,
      );
      if (!acknowledged) return null;
      if (draftGenerationRef.current === generationAtRequest) return latestRecord;
    }
  };

  const save = async () => {
    if (!commitReminderDrafts()) return;
    const currentProposal = proposalDraftRef.current;
    if (!currentProposal) return;
    const generationAtRequest = draftGenerationRef.current;
    setOperation("save"); setBusy(true); setError(null);
    try {
      const next = await api.updateWorkRefinement(record.id, {
        expectedRevision: record.revision,
        proposal: currentProposal,
      });
      acknowledgeServerProposal(next, generationAtRequest, currentProposal);
    } catch (cause) {
      if (isStaleWriteConflict(cause)) setConflict(true);
      setError(localizedErrorMessage(cause, strings));
    }
    finally { setBusy(false); setOperation(null); }
  };
  const apply = async () => {
    if (!commitReminderDrafts()) return;
    setOperation("apply"); setBusy(true); setError(null);
    try {
      const current = await persistLatestProposal();
      if (!current) return;
      const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;
      onChange(await api.applyWorkRefinement(record.id, {
        expectedRevision: current.revision,
        ...(activationResolution ? { activationResolution } : {}),
      }));
    } catch (cause) {
      const prompt = projectActivationPromptFromError(cause, activationPrompt);
      if (prompt) setActivationPrompt(prompt);
      setError(localizedErrorMessage(cause, strings));
    }
    finally { setBusy(false); setOperation(null); }
  };
  const regenerate = async () => {
    if (!commitReminderDrafts()) return;
    setOperation("regenerate"); setBusy(true); setError(null);
    try {
      const saved = await persistLatestProposal();
      if (!saved) return;
      allowServerReplacementRef.current = true;
      onChange(await api.retryIntake(record.id, answer));
      setAnswer("");
    }
    catch (cause) {
      allowServerReplacementRef.current = false;
      setError(localizedErrorMessage(cause, strings));
    }
    finally { setBusy(false); setOperation(null); }
  };
  const discard = async () => {
    setOperation("discard"); setBusy(true);
    try { await api.deleteIntake(record.id); navigate("/today"); }
    catch (cause) { setError(localizedErrorMessage(cause, strings)); }
    finally { setBusy(false); setOperation(null); }
  };
  const label = (change: WorkRefinementChange) => change.kind === "update_wait"
    ? strings[contextLabels.get(change.taskId)?.waitingFor ? "refinementWaitUpdate" : "refinementWaitStart"]
    : strings[labels[change.kind]];
  const contextLabels = new Map<number, { title: string; path: string; role: "task" | "project"; status: string; kind: string | null; position: number; parentTaskId: number | null; projectId: number | null; scheduledDate: string | null; dueDate: string | null; revisitAt: string | null; reminders: TaskReminderInput[]; waitingFor: string | null }>();
  try {
    const walk = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      if (typeof item.id === "number" && typeof item.title === "string") {
        const role = Array.isArray(item.tasks) || Array.isArray(item.projects) ? "projects" : "tasks";
        const externalWait = item.externalWait && typeof item.externalWait === "object" ? item.externalWait as Record<string, unknown> : null;
        contextLabels.set(item.id, {
          title: item.title,
          path: `/${role}/${item.id}`,
          role: role === "projects" ? "project" : "task",
          status: typeof item.status === "string" ? item.status : "",
          kind: typeof item.kind === "string" ? item.kind : null,
          position: Number(item.position ?? 0),
          parentTaskId: typeof item.parentTaskId === "number" ? item.parentTaskId : null,
          projectId: typeof item.projectId === "number" ? item.projectId : null,
          scheduledDate: typeof item.scheduledDate === "string" ? item.scheduledDate : null,
          dueDate: typeof item.dueDate === "string" ? item.dueDate : null,
          revisitAt: typeof item.revisitAt === "string" ? item.revisitAt : null,
          reminders: Array.isArray(item.reminders) ? item.reminders as TaskReminderInput[] : [],
          waitingFor: typeof externalWait?.waitingFor === "string" ? externalWait.waitingFor : null,
        });
      }
      for (const key of ["children", "tasks", "projects"]) if (Array.isArray(item[key])) item[key].forEach(walk);
    };
    if (record.text) walk(JSON.parse(record.text));
  } catch { /* a legacy intake's text need not be JSON */ }
  const moveSiblings = (change: Extract<WorkRefinementChange, { kind: "move_task" }>) => [...contextLabels.entries()]
    .filter(([id, value]) => id !== change.targetId && value.parentTaskId === change.parentTaskId && value.projectId === change.projectId)
    .sort((a, b) => a[1].position - b[1].position);
  const openDescendants = (taskId: number) => [...contextLabels.entries()].filter(([id, item]) => {
    if (id === taskId || item.role !== "task" || ["done", "cancelled"].includes(item.status) || item.kind === "reference") return false;
    let parentId = item.parentTaskId;
    const visited = new Set<number>();
    while (parentId !== null && !visited.has(parentId)) {
      if (parentId === taskId) return true;
      visited.add(parentId);
      parentId = contextLabels.get(parentId)?.parentTaskId ?? null;
    }
    return false;
  });
  const proposalParentIssue = proposal.changes.find((change) => change.kind === "create_child" && change.accepted && change.parentProposalKey && !proposal.changes.some((parent) => parent.kind === "create_child" && parent.proposalKey === change.parentProposalKey && parent.accepted));
  const hasNestedCycle = (() => {
    const keyed = new Map(proposal.changes.flatMap((change) => change.kind === "create_child" && change.proposalKey && change.accepted ? [[change.proposalKey, change] as const] : []));
    for (const change of keyed.values()) {
      const seen = new Set<string>();
      let current: typeof change | undefined = change;
      while (current?.parentProposalKey) {
        if (seen.has(current.parentProposalKey)) return true;
        seen.add(current.parentProposalKey);
        current = keyed.get(current.parentProposalKey);
        if (!current) return true;
      }
    }
    return false;
  })();
  const missingCancelPolicy = proposal.changes.some((change) => change.kind === "cancel_task" && change.accepted && openDescendants(change.targetId).length > 0 && !change.descendantsPolicy);
  const childIndexByKey = new Map(proposal.changes.flatMap((change, index) => change.kind === "create_child" && change.proposalKey ? [[change.proposalKey, index] as const] : []));
  const displayChanges: Array<{ change: WorkRefinementChange; index: number }> = [];
  const displayed = new Set<number>();
  const displayChange = (index: number) => {
    if (displayed.has(index)) return;
    displayed.add(index);
    const change = proposal.changes[index];
    if (!change) return;
    if (change.kind === "create_child" && change.parentProposalKey) {
      const parentIndex = childIndexByKey.get(change.parentProposalKey);
      if (parentIndex !== undefined) displayChange(parentIndex);
    }
    displayChanges.push({ change, index });
  };
  proposal.changes.forEach((_change, index) => displayChange(index));
  const targetPath = refinement.targetType === "project" ? `/projects/${refinement.targetId}` : `/tasks/${refinement.targetId}`;
  const revisitSummary = (value: string | null | undefined) => value
    ? `${calendarDateForInstant(value, householdTimezone) ?? value} ${localTimeForInstant(value, householdTimezone) ?? ""}`.trim()
    : strings.refinementNone;
  const leaveAlone = proposal.disposition === "leave_alone";
  let source: Record<string, unknown> | null = null;
  try {
    source = record.text ? JSON.parse(record.text) as Record<string, unknown> : null;
  } catch {
    source = null;
  }
  const sourceStatus = source?.status;
  const sourceOwnerMemberId = typeof source?.ownerMemberId === "number" ? source.ownerMemberId : null;
  const conversion = proposal.changes.find(
    (change) => change.kind === "convert_task_to_project" &&
      change.targetId === refinement.targetId,
  );
  const activeConversion =
    conversion?.accepted === true &&
    refinement.targetType === "task" &&
    (sourceStatus === "actionable" || activationPrompt !== null);
  const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;
  const canRegenerate = record.status === "ready" || record.status === "analysis_failed";
  const hasRetryFeedback = answer.trim().length > 0;
  return <main className="page stack">
    {!leaveAlone ? <header className="stack"><p className="eyebrow">{strings.workRefinement}</p><h1>{refinement.targetType === "project" ? strings.project : strings.task}</h1></header> : null}
    <section className="card stack">
      {leaveAlone ? <><h1>{strings.refinementLeaveAlone}</h1><p>{proposal.summary}</p><Link className="btn" to={targetPath}>{strings.refinementOpenOriginal}</Link></> : <>
        <h2>{proposal.summary}</h2>
        {proposal.question ? <><strong>{strings.refinementQuestionLabel}</strong><p>{proposal.question}</p></> : null}
      </>}
      {record.error ? (
        <section role="alert" className="stack">
          <p className="error-text">{record.error.message}</p>
          {intakeErrorIssues(record.error).map((issue, index) => (
            <p key={`${issue.path.join(".")}-${issue.code}-${index}`}>
              <code>{issue.path.length ? issue.path.join(".") : "(proposal)"}</code>: {issue.message}
            </p>
          ))}
        </section>
      ) : null}
      {conflict ? <p role="alert" className="error-text">{strings.refinementConflict}</p> : null}
      {!leaveAlone ? displayChanges.map(({ change, index }) => <article className="card stack" style={change.kind === "create_child" && change.parentProposalKey ? { marginInlineStart: "1rem" } : undefined} key={`${change.kind}-${index}`}>
        {change.kind === "convert_task_to_project" && change.targetId === refinement.targetId && change.accepted ? (
          <section className="card stack">
            <strong>{activeConversion ? strings.aiProjectWillBeActive : strings.aiProjectWillBeBacklog}</strong>
            {activeConversion && sourceOwnerMemberId !== null ? (
              <p>{strings.aiProjectDriverLabel}: {members.find((member) => member.id === sourceOwnerMemberId)?.name ?? sourceOwnerMemberId}</p>
            ) : null}
          </section>
        ) : null}
        <label className="inline-row"><input type="checkbox" checked={change.accepted} disabled={change.kind === "advisory" || busy} onChange={(event) => {
          const checked = event.target.checked;
          setDraft({ ...proposal, changes: proposal.changes.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, accepted: checked } : candidate) as WorkRefinementChange[] });
        }} /><strong>{label(change)}</strong></label>
        {Object.entries(change).filter(([key, value]) => ["targetId", "taskId", "parentTaskId", "projectId", "dependsOnTaskId"].includes(key) && typeof value === "number").map(([key, value]) => {
          const context = contextLabels.get(value as number);
          return <small key={key}>{context ? <Link to={context.path} target="_blank" rel="noreferrer">{context.title}</Link> : `#${value}`}</small>;
        })}
        <p>{change.rationale}</p>
        {change.kind === "create_child" ? <label className="stack"><span>{strings.refinementNestedParent}</span><select disabled={editorLocked} value={change.parentProposalKey ? `proposal:${change.parentProposalKey}` : `existing:${change.parentTaskId ?? ""}`} onChange={(event) => {
          const value = event.target.value;
          const parentPatch = value.startsWith("proposal:")
            ? { parentTaskId: undefined, parentProposalKey: value.slice("proposal:".length) }
            : { parentTaskId: Number(value.slice("existing:".length)), parentProposalKey: undefined };
          setDraft({ ...proposal, changes: proposal.changes.map((candidate, candidateIndex) => candidateIndex === index && candidate.kind === "create_child" ? { ...candidate, ...parentPatch } : candidate) as WorkRefinementChange[] });
          setError(null);
        }}>
          {[...contextLabels.entries()].filter(([, item]) => item.role === "task" || item.role === "project").map(([id, item]) => <option key={`existing:${id}`} value={`existing:${id}`}>{item.title}</option>)}
          {proposal.changes.flatMap((candidate) => candidate.kind === "create_child" && candidate.proposalKey && candidate.proposalKey !== change.proposalKey ? [<option key={`proposal:${candidate.proposalKey}`} value={`proposal:${candidate.proposalKey}`}>{candidate.title}</option>] : [])}
        </select></label> : null}
        {"title" in change ? <label className="stack"><span>{strings.title}</span><input disabled={editorLocked} value={change.title} onChange={(event) => update(index, { title: event.target.value })} /></label> : null}
        {"notes" in change && change.notes !== undefined ? <label className="stack"><span>{strings.notes}</span><textarea disabled={editorLocked} value={change.notes ?? ""} onChange={(event) => update(index, { notes: event.target.value })} /></label> : null}
        {change.kind === "update_task" || change.kind === "create_child" ? (() => {
          const existing = change.kind === "update_task" ? contextLabels.get(change.targetId) : undefined;
          const scheduledDate = change.scheduledDate !== undefined ? change.scheduledDate : existing?.scheduledDate ?? null;
          const dueDate = change.dueDate !== undefined ? change.dueDate : existing?.dueDate ?? null;
          const revisitAt = change.revisitAt !== undefined ? change.revisitAt : existing?.revisitAt ?? null;
          const revisitDate = revisitDrafts[index]?.date ?? (revisitAt ? calendarDateForInstant(revisitAt, householdTimezone) ?? "" : "");
          const revisitTime = revisitDrafts[index]?.time ?? (revisitAt ? localTimeForInstant(revisitAt, householdTimezone) ?? "06:00" : "06:00");
          const reminders = change.reminders !== undefined ? change.reminders : existing?.reminders ?? [];
          const reminderSummary = (value: TaskReminderInput[]) => value.length === 0
            ? strings.refinementNone
            : value.map((reminder) => reminder.kind === "absolute"
              ? `${calendarDateForInstant(reminder.at, householdTimezone) ?? reminder.at} ${localTimeForInstant(reminder.at, householdTimezone) ?? ""}`.trim()
              : `${reminder.daysBefore} ${strings.reminderDaysBeforeFieldLabel}, ${reminder.time} (${reminder.timezone})`).join(" · ");
          return <section className="card stack">
            <strong>{strings.refinementPlanning}</strong>
            {change.kind === "update_task" ? <small>{strings.refinementCurrent}: {existing?.title ?? strings.refinementUnavailable}</small> : null}
            <label className="stack"><span>{strings.refinementScheduledDate}</span><small>{strings.refinementCurrent}: {existing?.scheduledDate ?? strings.refinementNone} → {strings.refinementProposed}: {scheduledDate ?? strings.refinementNone}</small><input type="date" disabled={editorLocked} value={scheduledDate ?? ""} onChange={(event) => update(index, { scheduledDate: event.target.value || null })} /></label>
            <label className="stack"><span>{strings.refinementDueDate}</span><small>{strings.refinementCurrent}: {existing?.dueDate ?? strings.refinementNone} → {strings.refinementProposed}: {dueDate ?? strings.refinementNone}</small><input type="date" disabled={editorLocked} value={dueDate ?? ""} onChange={(event) => update(index, { dueDate: event.target.value || null })} /></label>
            <fieldset className="stack"><legend>{strings.refinementRevisit}</legend><small>{strings.refinementCurrent}: {existing?.revisitAt ? `${calendarDateForInstant(existing.revisitAt, householdTimezone) ?? existing.revisitAt} ${localTimeForInstant(existing.revisitAt, householdTimezone) ?? ""}` : strings.refinementNone} → {strings.refinementProposed}: {revisitAt ? `${revisitDate} ${revisitTime}` : strings.refinementNone}</small><div className="inline-row"><input aria-label={strings.refinementRevisitDate} type="date" disabled={editorLocked} value={revisitDate} onChange={(event) => {
              const date = event.target.value;
              setRevisitDrafts((current) => ({ ...current, [index]: { date, time: revisitTime } }));
              const converted = date ? householdCalendarDateTimeToRevisitAt(date, revisitTime, householdTimezone) : null;
              if (date && !converted) { setError(strings.refinementPlanningIncomplete); return; }
              update(index, { revisitAt: converted });
            }} /><input aria-label={strings.refinementRevisitTime} type="time" disabled={editorLocked || !revisitDate} value={revisitTime} onChange={(event) => {
              const time = event.target.value;
              setRevisitDrafts((current) => ({ ...current, [index]: { date: revisitDate, time } }));
              const converted = revisitDate ? householdCalendarDateTimeToRevisitAt(revisitDate, time, householdTimezone) : null;
              if (revisitDate && !converted) { setError(strings.refinementPlanningIncomplete); return; }
              update(index, { revisitAt: converted });
            }} /><button type="button" className="btn btn-sm" disabled={editorLocked || !revisitAt} onClick={() => {
              setRevisitDrafts((current) => ({ ...current, [index]: { date: "", time: revisitTime } }));
              update(index, { revisitAt: null });
            }}>{strings.clearNotBefore}</button></div></fieldset>
            <div className="stack"><strong>{strings.refinementReminders}</strong><small>{strings.refinementCurrent}: {reminderSummary(existing?.reminders ?? [])} → {strings.refinementProposed}: {reminderSummary(reminders)}</small><TaskRemindersEditor
              key={`${record.id}:${editorResetGeneration}:${index}`}
              ref={(editor) => { if (editor) reminderEditors.current.set(index, editor); else reminderEditors.current.delete(index); }}
              reminders={reminders}
              dueDate={dueDate}
              householdTimezoneAbsoluteLabels
              disabled={editorLocked}
              onPendingChange={(pending) => setPendingReminderEditors((current) => current[index] === pending
                ? current
                : { ...current, [index]: pending })}
              onChange={(next) => update(index, { reminders: next })}
            /></div>
          </section>;
        })() : null}
        {change.kind === "update_wait" ? (() => {
          const existing = contextLabels.get(change.taskId);
          const revisitAt = change.revisitAt !== undefined ? change.revisitAt : existing?.revisitAt ?? null;
          const revisitDate = revisitDrafts[index]?.date ?? (revisitAt ? calendarDateForInstant(revisitAt, householdTimezone) ?? "" : "");
          const revisitTime = revisitDrafts[index]?.time ?? (revisitAt ? localTimeForInstant(revisitAt, householdTimezone) ?? "06:00" : "06:00");
          return <section className="stack"><label className="stack"><span>{strings.refinementWait}</span><small>{strings.refinementWaitCurrent}: {existing?.waitingFor ?? strings.refinementNone} → {strings.refinementProposed}: {change.waitingFor}</small><input disabled={editorLocked} value={change.waitingFor} onChange={(event) => update(index, { waitingFor: event.target.value })} /></label><fieldset className="stack"><legend>{strings.refinementRevisit}</legend><small>{strings.refinementCurrent}: {revisitSummary(existing?.revisitAt)} → {strings.refinementProposed}: {revisitAt ? `${revisitDate} ${revisitTime}` : strings.refinementNone}</small><div className="inline-row"><input aria-label={strings.refinementRevisitDate} type="date" disabled={editorLocked} value={revisitDate} onChange={(event) => {
            const date = event.target.value;
            setRevisitDrafts((current) => ({ ...current, [index]: { date, time: revisitTime } }));
            const converted = date ? householdCalendarDateTimeToRevisitAt(date, revisitTime, householdTimezone) : null;
            if (date && !converted) { setError(strings.refinementPlanningIncomplete); return; }
            update(index, { revisitAt: converted });
          }} /><input aria-label={strings.refinementRevisitTime} type="time" disabled={editorLocked || !revisitDate} value={revisitTime} onChange={(event) => {
            const time = event.target.value;
            setRevisitDrafts((current) => ({ ...current, [index]: { date: revisitDate, time } }));
            const converted = revisitDate ? householdCalendarDateTimeToRevisitAt(revisitDate, time, householdTimezone) : null;
            if (revisitDate && !converted) { setError(strings.refinementPlanningIncomplete); return; }
            update(index, { revisitAt: converted });
          }} /><button type="button" className="btn btn-sm" disabled={editorLocked || !revisitAt} onClick={() => {
            setRevisitDrafts((current) => ({ ...current, [index]: { date: "", time: revisitTime } }));
            update(index, { revisitAt: null });
          }}>{strings.clearNotBefore}</button></div></fieldset></section>;
        })() : null}
        {change.kind === "resolve_wait" ? <section className="card stack"><strong>{strings.refinementWaitCurrent}</strong><p>{contextLabels.get(change.taskId)?.waitingFor ?? strings.refinementUnavailable}</p><small>{strings.refinementWaitRevisit}: {revisitSummary(contextLabels.get(change.taskId)?.revisitAt)}</small><p>{strings.refinementResolveWaitHelp}</p></section> : null}
        {change.kind === "cancel_task" ? <section className="card stack"><strong>{strings.refinementCancellationImpact}: {openDescendants(change.targetId).length}</strong>{openDescendants(change.targetId).map(([id, item]) => <small key={id}>{item.title}</small>)}{openDescendants(change.targetId).length ? <label className="stack"><span>{strings.refinementCancellationPolicy}</span><select disabled={editorLocked} value={change.descendantsPolicy ?? ""} onChange={(event) => update(index, { descendantsPolicy: event.target.value ? event.target.value as Extract<WorkRefinementChange, { kind: "cancel_task" }>['descendantsPolicy'] : undefined })}><option value="">{strings.refinementUnavailable}</option><option value="leave_open">{strings.refinementCancelLeaveOpen}</option><option value="cancel_children">{strings.refinementCancelChildren}</option><option value="complete_children">{strings.refinementCompleteChildren}</option></select></label> : <p>{strings.refinementCancel}</p>}</section> : null}
        {change.kind === "update_project_outcome" ? <label className="stack"><span>{strings.refinementOutcome}</span><textarea disabled={editorLocked} value={change.outcome} onChange={(event) => update(index, { outcome: event.target.value })} /></label> : null}
        {change.kind === "move_task" ? <label className="stack"><span>{strings.refinementMoveDestination}</span><select disabled={editorLocked} value={change.position} onChange={(event) => update(index, { position: Number(event.target.value) })}>
          {Array.from({ length: moveSiblings(change).length + 1 }, (_, position) => {
            const siblings = moveSiblings(change);
            const text = position === 0 ? strings.refinementMoveBeginning : position >= siblings.length ? strings.refinementMoveEnd : `${strings.refinementMoveAfter} ${contextLabels.get(siblings[position - 1]![0])?.title ?? ""}`;
            return <option key={position} value={position}>{text}</option>;
          })}
        </select></label> : null}
        {change.kind === "advisory" ? <p>{change.title}</p> : null}
      </article>) : null}
      {activationPrompt ? <ProjectActivationDecisionFields
        prompt={activationPrompt}
        disabled={editorLocked}
        onChange={setActivationPrompt}
      /> : null}
      <label className="stack"><span>{proposal.question ? strings.refinementAnswerLabel : strings.refinementFeedbackLabel}</span><textarea disabled={editorLocked} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={proposal.question ?? strings.workRefinementPlaceholder} /></label>
      {error ? <p role="alert" className="error-text">{error}</p> : null}
      {proposalParentIssue || hasNestedCycle || missingCancelPolicy ? <p role="alert" className="error-text">{proposalParentIssue ? strings.refinementParentRequired : hasNestedCycle ? strings.refinementNestedCycle : strings.refinementCancellationPolicy}</p> : null}
      <div className="actions">
        {hasRetryFeedback || record.status === "analysis_failed" ? <button className="btn" disabled={busy || !canRegenerate} onClick={() => void regenerate()}>{hasRetryFeedback ? proposal.question ? strings.refinementRegenerate : strings.refinementRegenerateFeedback : strings.intakeRetry}</button> : null}
        {leaveAlone
          ? <button className="btn btn-primary" disabled={busy || record.status !== "ready"} onClick={() => void apply()}>{strings.refinementDone}</button>
          : <>
            <button className="btn btn-primary" disabled={busy || record.status !== "ready" || proposal.disposition === "clarification" || activationPrompt !== null && activationResolution === null || Boolean(proposalParentIssue) || hasNestedCycle || missingCancelPolicy} onClick={() => void apply()}>{strings.refinementApply}</button>
            <button className="btn" disabled={busy} onClick={() => void save()}>{strings.save}</button>
            <button className="btn" disabled={busy} onClick={() => void discard()}>{strings.intakeDiscard}</button>
          </>}
      </div>
    </section>
  </main>;
}
