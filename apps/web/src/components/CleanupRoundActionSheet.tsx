import { useId, useState } from "react";
import type { CleanupTargetType } from "@machbar/shared";
import { api, type ProjectDetail, type TaskDetail } from "../lib/api";
import type { CleanupMicroFlow } from "../lib/cleanupRound";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { useAsync } from "../lib/useAsync";
import { useProjectActions } from "../lib/useProjectActions";
import { useTaskActions } from "../lib/useTaskActions";
import { ErrorState, LoadingState } from "./AsyncStates";
import { BottomSheet } from "./BottomSheet";

/**
 * Focused Klärungsrunde confirmation: shows the target and the exact title or
 * text that will be written, lets the user adjust it, and commits one explicit
 * change through the canonical paths (task/project update actions for titles,
 * the notes-append endpoints, child/project task creation, and criterion add).
 * It never touches `reviewedAt`; after success the caller hides the card.
 */
export function CleanupRoundActionSheet({
  targetType,
  targetId,
  flow,
  onClose,
  onApplied,
}: {
  targetType: CleanupTargetType;
  targetId: number;
  flow: CleanupMicroFlow;
  onClose: () => void;
  /** Runs after the mutation succeeded (hides the Klärungsrunde card). */
  onApplied: () => Promise<void> | void;
}) {
  const strings = useStrings();
  const labels = strings.cleanupFlow;
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const taskActions = useTaskActions();
  const projectActions = useProjectActions();
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

  const rename = async () => {
    const loaded = target.data;
    if (!loaded) return;
    if (loaded.kind === "project") {
      await projectActions.update(loaded.item, { title: trimmedTitle }, { title: trimmedTitle }, true);
    } else {
      await taskActions.update(loaded.item, { title: trimmedTitle }, { title: trimmedTitle }, true);
    }
  };
  const appendNotes = (content: string) =>
    isProject ? api.appendProjectNotes(targetId, content) : api.appendTaskNotes(targetId, content);

  const apply = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      switch (flow.kind) {
        case "rename":
          await rename();
          break;
        case "createTask": {
          const input = { title: trimmedTitle, createdByMemberId: currentMemberId, status: "actionable" as const };
          // Owner/context/tags inherit from the parent task or project as usual.
          await (isProject
            ? api.createTask({ ...input, projectId: targetId, parentTaskId: null })
            : api.createChildTask(targetId, input));
          break;
        }
        case "addCriterion":
          await api.addCriterion(targetId, trimmedText);
          break;
        case "appendNotes":
          await appendNotes(trimmedText);
          break;
        case "clarifyAdmin":
          if (titleChanged) await rename();
          if (trimmedText) await appendNotes(trimmedText);
          break;
      }
      bump();
      await onApplied();
      onClose();
    } catch (cause) {
      if (isStaleWriteConflict(cause)) target.reload();
      setError(localizedErrorMessage(cause, strings));
    } finally {
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
