import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { intakeErrorIssues, type IntakeRecord, type WorkRefinementChange } from "@machbar/shared";
import { api } from "../lib/api";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { MemberChoiceGroup } from "./MemberChoiceGroup";

const labels = {
  update_task: "refinementTitle", update_project: "refinementTitle", convert_task_to_project: "refinementConvert", create_child: "refinementCreate",
  move_task: "refinementMove", add_dependency: "refinementDependency", update_wait: "refinementWait",
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
  const [error, setError] = useState<string | null>(null);
  const [projectDriverMemberId, setProjectDriverMemberId] = useState<number | null>(null);
  const incomingProposalSignature = semanticSignature(serverProposal);

  const setDraft = useCallback((next: RefinementProposal | null, userEdit = true) => {
    proposalDraftRef.current = next;
    if (userEdit) draftGenerationRef.current += 1;
    setProposalDraft(next);
  }, []);

  useEffect(() => {
    const incomingBaseline: ServerProposalBaseline = {
      recordId: record.id,
      revision: record.revision,
      proposal: serverProposal,
      signature: incomingProposalSignature,
    };
    const previous = serverBaselineRef.current;

    if (previous.recordId !== record.id) {
      serverBaselineRef.current = incomingBaseline;
      setDraft(serverProposal, false);
      setConflict(false);
      setAnswer("");
      setError(null);
      return;
    }

    if (allowServerReplacementRef.current) {
      allowServerReplacementRef.current = false;
      serverBaselineRef.current = incomingBaseline;
      setDraft(serverProposal, false);
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
    const draftIsDirty = currentDraftSignature !== previous.signature;
    serverBaselineRef.current = incomingBaseline;

    if (!draftIsDirty) {
      setDraft(serverProposal, false);
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
    setDraft,
  ]);

  if (!refinement || !proposal) return null;
  const update = (index: number, patch: Partial<WorkRefinementChange>) => {
    const changes = proposal.changes.map((item, i) => i === index ? { ...item, ...patch } as WorkRefinementChange : item);
    setDraft({ ...proposal, changes });
  };

  const acknowledgeServerProposal = (
    next: IntakeRecord,
    generationAtRequest: number,
    fallbackProposal: RefinementProposal,
    options: { allowReplacement?: boolean } = {},
  ) => {
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
      acknowledgeServerProposal(
        latestRecord,
        generationAtRequest,
        currentProposal,
      );
      if (draftGenerationRef.current === generationAtRequest) return latestRecord;
    }
  };

  const save = async () => {
    const currentProposal = proposalDraftRef.current;
    if (!currentProposal) return;
    const generationAtRequest = draftGenerationRef.current;
    setBusy(true); setError(null);
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
    finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const current = await persistLatestProposal();
      if (!current) return;
      onChange(await api.applyWorkRefinement(record.id, {
        expectedRevision: current.revision,
        ...(projectDriverMemberId !== null ? { projectDriverMemberId } : {}),
      }));
    } catch (cause) { setError(localizedErrorMessage(cause, strings)); }
    finally { setBusy(false); }
  };
  const regenerate = async () => {
    setBusy(true); setError(null);
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
    finally { setBusy(false); }
  };
  const discard = async () => {
    setBusy(true);
    try { await api.deleteIntake(record.id); navigate("/today"); }
    catch (cause) { setError(localizedErrorMessage(cause, strings)); }
    finally { setBusy(false); }
  };
  const label = (change: WorkRefinementChange) => strings[labels[change.kind]];
  const contextLabels = new Map<number, { title: string; path: string; position: number; parentTaskId: number | null; projectId: number | null }>();
  try {
    const walk = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      if (typeof item.id === "number" && typeof item.title === "string") {
        const role = Array.isArray(item.tasks) || Array.isArray(item.projects) ? "projects" : "tasks";
        contextLabels.set(item.id, { title: item.title, path: `/${role}/${item.id}`, position: Number(item.position ?? 0), parentTaskId: typeof item.parentTaskId === "number" ? item.parentTaskId : null, projectId: typeof item.projectId === "number" ? item.projectId : null });
      }
      for (const key of ["children", "tasks", "projects"]) if (Array.isArray(item[key])) item[key].forEach(walk);
    };
    if (record.text) walk(JSON.parse(record.text));
  } catch { /* a legacy intake's text need not be JSON */ }
  const invalidSelection = proposal.changes.some((change) => {
    if (!change.accepted || change.kind !== "create_child") return false;
    const parent = contextLabels.get(change.parentTaskId);
    if (!parent) return false;
    let context: Record<string, unknown> | null = null;
    try { context = record.text ? JSON.parse(record.text) as Record<string, unknown> : null; } catch { /* no context */ }
    const find = (value: unknown): Record<string, unknown> | null => {
      if (!value || typeof value !== "object") return null;
      const item = value as Record<string, unknown>;
      if (item.id === change.parentTaskId) return item;
      for (const key of ["children", "tasks", "projects"]) if (Array.isArray(item[key])) for (const child of item[key] as unknown[]) { const found = find(child); if (found) return found; }
      return null;
    };
    const parentNode = find(context);
    if (parentNode?.status !== "captured") return false;
    return !proposal.changes.some((candidate) => candidate.kind === "convert_task_to_project" && candidate.targetId === change.parentTaskId && candidate.accepted);
  });
  const moveSiblings = (change: Extract<WorkRefinementChange, { kind: "move_task" }>) => [...contextLabels.entries()]
    .filter(([id, value]) => id !== change.targetId && value.parentTaskId === change.parentTaskId && value.projectId === change.projectId)
    .sort((a, b) => a[1].position - b[1].position);
  const targetPath = refinement.targetType === "project" ? `/projects/${refinement.targetId}` : `/tasks/${refinement.targetId}`;
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
    sourceStatus === "actionable";
  const requiresDriver = activeConversion && sourceOwnerMemberId === null;
  const hasUnsupportedTiming = activeConversion && (
    source?.revisitAt != null || source?.notBeforeAt != null || source?.notBeforeDate != null
  );
  const acceptedTaskConversion =
    conversion?.accepted === true && refinement.targetType === "task";
  const hasTaskOnlyMetadata = acceptedTaskConversion && (
    source?.priority != null || source?.size != null
  );
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
      {!leaveAlone ? proposal.changes.map((change, index) => <article className="card stack" key={`${change.kind}-${index}`}>
        {change.kind === "convert_task_to_project" && change.targetId === refinement.targetId && change.accepted ? (
          <section className="card stack">
            <strong>{activeConversion ? strings.aiProjectWillBeActive : strings.aiProjectWillBeBacklog}</strong>
            {activeConversion && sourceOwnerMemberId !== null ? (
              <p>{strings.aiProjectDriverLabel}: {members.find((member) => member.id === sourceOwnerMemberId)?.name ?? sourceOwnerMemberId}</p>
            ) : null}
            {requiresDriver ? (
              <>
                <p>{strings.aiProjectDriverHint}</p>
                <MemberChoiceGroup
                  label={strings.aiProjectDriverLabel}
                  idPrefix="refinement-project-driver"
                  members={members}
                  value={projectDriverMemberId}
                  onChange={(memberId) => {
                    if (memberId !== null) setProjectDriverMemberId(memberId);
                  }}
                  unassignedLabel={null}
                />
              </>
            ) : null}
            {hasUnsupportedTiming ? <p role="alert">{strings.aiProjectTimingWarning}</p> : null}
            {hasTaskOnlyMetadata ? <p role="status">{strings.aiProjectMetadataWarning}</p> : null}
          </section>
        ) : null}
        {change.kind === "create_child" && proposal.changes.some((candidate) => candidate.kind === "convert_task_to_project" && candidate.targetId === change.parentTaskId) ? <p className="muted">{strings.refinementRequiresConversion}</p> : null}
        <label className="inline-row"><input type="checkbox" checked={change.accepted} disabled={change.kind === "advisory" || busy} onChange={(event) => {
          const checked = event.target.checked;
          setDraft({ ...proposal, changes: proposal.changes.map((candidate, candidateIndex) => ({
            ...candidate,
            accepted: candidateIndex === index ? checked
              : !checked && change.kind === "convert_task_to_project" && candidate.kind === "create_child" && candidate.parentTaskId === change.targetId ? false
              : candidate.accepted,
          })) as WorkRefinementChange[] });
        }} /><strong>{label(change)}</strong></label>
        {Object.entries(change).filter(([key, value]) => ["targetId", "taskId", "parentTaskId", "projectId", "dependsOnTaskId"].includes(key) && typeof value === "number").map(([key, value]) => {
          const context = contextLabels.get(value as number);
          return <small key={key}>{context ? <Link to={context.path} target="_blank" rel="noreferrer">{context.title}</Link> : `#${value}`}</small>;
        })}
        <p>{change.rationale}</p>
        {"title" in change ? <label className="stack"><span>{strings.title}</span><input value={change.title} onChange={(event) => update(index, { title: event.target.value })} /></label> : null}
        {"notes" in change && change.notes !== undefined ? <label className="stack"><span>{strings.notes}</span><textarea value={change.notes ?? ""} onChange={(event) => update(index, { notes: event.target.value })} /></label> : null}
        {change.kind === "update_wait" ? <label className="stack"><span>{strings.refinementWait}</span><input value={change.waitingFor} onChange={(event) => update(index, { waitingFor: event.target.value })} /></label> : null}
        {change.kind === "update_project_outcome" ? <label className="stack"><span>{strings.refinementOutcome}</span><textarea value={change.outcome} onChange={(event) => update(index, { outcome: event.target.value })} /></label> : null}
        {change.kind === "move_task" ? <label className="stack"><span>{strings.refinementMoveDestination}</span><select value={change.position} onChange={(event) => update(index, { position: Number(event.target.value) })}>
          {Array.from({ length: moveSiblings(change).length + 1 }, (_, position) => {
            const siblings = moveSiblings(change);
            const text = position === 0 ? strings.refinementMoveBeginning : position >= siblings.length ? strings.refinementMoveEnd : `${strings.refinementMoveAfter} ${contextLabels.get(siblings[position - 1]![0])?.title ?? ""}`;
            return <option key={position} value={position}>{text}</option>;
          })}
        </select></label> : null}
        {change.kind === "advisory" ? <p>{change.title}</p> : null}
      </article>) : null}
      <label className="stack"><span>{proposal.question ? strings.refinementAnswerLabel : strings.refinementFeedbackLabel}</span><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={proposal.question ?? strings.workRefinementPlaceholder} /></label>
      {error ? <p role="alert" className="error-text">{error}</p> : null}
      <div className="actions">
        {hasRetryFeedback || record.status === "analysis_failed" ? <button className="btn" disabled={busy || !canRegenerate} onClick={() => void regenerate()}>{hasRetryFeedback ? proposal.question ? strings.refinementRegenerate : strings.refinementRegenerateFeedback : strings.intakeRetry}</button> : null}
        {leaveAlone
          ? <button className="btn btn-primary" disabled={busy || record.status !== "ready"} onClick={() => void apply()}>{strings.refinementDone}</button>
          : <>
            <button className="btn btn-primary" disabled={busy || record.status !== "ready" || proposal.disposition === "clarification" || invalidSelection || hasUnsupportedTiming || requiresDriver && projectDriverMemberId === null} onClick={() => void apply()}>{strings.refinementApply}</button>
            <button className="btn" disabled={busy} onClick={() => void save()}>{strings.save}</button>
            <button className="btn" disabled={busy} onClick={() => void discard()}>{strings.intakeDiscard}</button>
          </>}
      </div>
    </section>
  </main>;
}
