import { useId, useState } from "react";
import type { CleanupRoundActionRequest, CleanupRoundRecord, CleanupTargetType } from "@machbar/shared";
import { api, type ProjectDetail, type TaskDetail } from "../lib/api";
import type { CleanupMicroFlow } from "../lib/cleanupRound";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { useAsync } from "../lib/useAsync";
import { ErrorState, LoadingState } from "./AsyncStates";
import { BottomSheet } from "./BottomSheet";

/**
 * Focused Klärungsrunde confirmation: shows the target and the exact title or
 * text that will be written and lets the user adjust it. Confirming calls one
 * narrow cleanup-round action endpoint, which applies the canonical mutation
 * and dismisses the card in a single transaction — either the item improves
 * and the card disappears, or nothing changes and the error stays here.
 * It never touches `reviewedAt`.
 */
export function CleanupRoundActionSheet({
  roundId,
  itemId,
  targetType,
  targetId,
  flow,
  onClose,
  onApplied,
}: {
  roundId: string;
  itemId: string;
  targetType: CleanupTargetType;
  targetId: number;
  flow: CleanupMicroFlow;
  onClose: () => void;
  /** Receives the round as returned by the action endpoint. */
  onApplied: (round: CleanupRoundRecord) => void;
}) {
  const strings = useStrings();
  const labels = strings.cleanupFlow;
  const { bump } = useRefresh();
  const isProject = targetType === "project";
  // Load the current item so the sheet shows its real title and title writes
  // carry its current revision (stale writes are rejected, not overwritten).
  const target = useAsync<
    { kind: "project"; item: ProjectDetail } | { kind: "task"; item: TaskDetail }
  >(
    async () =>
      isProject
        ? { kind: "project", item: await api.getProject(targetId) }
        : { kind: "task", item: await api.getTask(targetId) },
    [isProject, targetId],
  );
  const [title, setTitle] = useState(
    flow.kind === "rename" || flow.kind === "createTask" || flow.kind === "clarifyAdmin" ? flow.title : "",
  );
  const [text, setText] = useState(
    flow.kind === "addCriterion" || flow.kind === "appendNotes" ? flow.text : flow.kind === "clarifyAdmin" ? flow.notes : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const textId = useId();

  const current = target.data?.item ?? null;
  const trimmedTitle = title.trim();
  const trimmedText = text.trim();
  const titleChanged = current !== null && trimmedTitle !== "" && trimmedTitle !== current.title;
  const ready =
    current !== null &&
    (flow.kind === "rename"
      ? titleChanged
      : flow.kind === "createTask"
        ? trimmedTitle !== ""
        : flow.kind === "clarifyAdmin"
          ? titleChanged || trimmedText !== ""
          : trimmedText !== "");

  const request = (revision: number): CleanupRoundActionRequest => {
    switch (flow.kind) {
      case "rename":
        return { action: "rename", title: trimmedTitle, expectedRevision: revision };
      case "createTask":
        return { action: "create-task", title: trimmedTitle, purpose: flow.purpose };
      case "addCriterion":
      case "appendNotes":
        return { action: "add-done-when", text: trimmedText };
      case "clarifyAdmin":
        return {
          action: "clarify-admin",
          ...(titleChanged ? { title: trimmedTitle } : {}),
          ...(trimmedText ? { notes: trimmedText } : {}),
          expectedRevision: revision,
        };
    }
  };

  const apply = async () => {
    if (!ready || busy || !current) return;
    setBusy(true);
    setError(null);
    try {
      const round = await api.applyCleanupRoundAction(roundId, itemId, request(current.revision));
      bump();
      onClose();
      onApplied(round);
    } catch (cause) {
      // Nothing was applied: keep the sheet, the card, and the user's draft.
      // A stale target only refreshes the preview; the draft stays as typed.
      if (isStaleWriteConflict(cause)) target.reload();
      setError(localizedErrorMessage(cause, strings));
      setBusy(false);
    }
  };

  const heading =
    flow.kind === "rename"
      ? isProject ? labels.renameProject : labels.renameTask
      : flow.kind === "createTask"
        ? labels[flow.purpose]
        : flow.kind === "addCriterion"
          ? labels.doneWhenProject
          : flow.kind === "appendNotes"
            ? labels.doneWhenTask
            : labels.admin;
  const confirmLabel =
    flow.kind === "rename"
      ? labels.renameConfirm
      : flow.kind === "createTask"
        ? isProject ? labels.createProjectTaskConfirm : labels.createChildConfirm
        : flow.kind === "addCriterion"
          ? labels.criterionConfirm
          : flow.kind === "appendNotes"
            ? labels.notesConfirm
            : labels.adminConfirm;
  const targetLabel =
    flow.kind === "rename" || flow.kind === "clarifyAdmin"
      ? flow.kind === "rename" ? labels.oldTitle : labels.currentTitle
      : flow.kind === "createTask"
        ? isProject ? labels.parentProject : labels.parentTask
        : isProject ? labels.projectTarget : labels.taskTarget;
  const titleLabel =
    flow.kind === "rename"
      ? labels.newTitle
      : flow.kind === "clarifyAdmin"
        ? labels.newWording
        : isProject ? labels.newProjectTask : labels.newChildTask;
  const textLabel =
    flow.kind === "addCriterion" ? labels.criterion : flow.kind === "appendNotes" ? labels.notesEntry : labels.adminNotes;
  const showTitle = flow.kind === "rename" || flow.kind === "createTask" || flow.kind === "clarifyAdmin";
  const showText = flow.kind === "addCriterion" || flow.kind === "appendNotes" || flow.kind === "clarifyAdmin";

  return (
    <BottomSheet title={heading} onClose={() => !busy && onClose()}>
      {target.loading && !current ? (
        <LoadingState />
      ) : !current ? (
        <ErrorState message={target.error ?? strings.cleanupRoundItemMissing} onRetry={target.reload} />
      ) : (
        <form
          className="stack cleanup-flow"
          onSubmit={(event) => {
            event.preventDefault();
            void apply();
          }}
        >
          <dl className="cleanup-flow-target">
            <dt>{targetLabel}</dt>
            <dd>{current.title}</dd>
          </dl>
          {showTitle ? (
            <div className="field">
              <label htmlFor={titleId}>{titleLabel}</label>
              <input id={titleId} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
            </div>
          ) : null}
          {showText ? (
            <div className="field">
              <label htmlFor={textId}>{textLabel}</label>
              <textarea id={textId} rows={3} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
              {flow.kind !== "addCriterion" ? <small className="text-muted">{labels.notesHint}</small> : null}
            </div>
          ) : null}
          <p className="text-muted cleanup-flow-hint">{labels.confirmHint}</p>
          {error ? (
            <p className="task-row-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
              {confirmLabel}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              {strings.cancel}
            </button>
          </div>
        </form>
      )}
    </BottomSheet>
  );
}
