import { useEffect, useState } from "react";
import type { AcceptanceCriterion, Project, Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { hasOpenDescendants } from "../lib/taskHelpers";
import type { ChildPolicy } from "../lib/useTaskActions";
import { BottomSheet } from "./BottomSheet";
import { localizedErrorMessage } from "../lib/errorMessage";

/**
 * The focused continuation for project or task completion when acceptance
 * criteria remain unchecked. Checkmarks are a local completion draft and
 * are submitted with the completion command, so closing the sheet persists
 * nothing.
 */
export function CompleteWithCriteriaSheet({
  workItem,
  workItemType,
  onClose,
  onComplete,
  onRefresh,
}: {
  workItem: (Pick<Project, "id" | "title"> & { acceptanceCriteria: AcceptanceCriterion[] }) | Task;
  workItemType: "project" | "task";
  onClose: () => void;
  onComplete: (criteriaToCheck: number[], childPolicy?: ChildPolicy) => Promise<void>;
  onRefresh?: () => void;
}) {
  const strings = useStrings();
  const criteria = workItem.acceptanceCriteria ?? [];
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set(criteria.filter((criterion) => criterion.checked).map((criterion) => criterion.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allChecked = criteria.every((criterion) => checkedIds.has(criterion.id));
  const taskHasOpenDescendants = workItemType === "task" && hasOpenDescendants(workItem as Task);
  const [childPolicy, setChildPolicy] = useState<ChildPolicy | null>(null);
  useEffect(() => {
    const checked = criteria.filter((criterion) => criterion.checked).map((criterion) => criterion.id);
    setCheckedIds((previous) => new Set([...previous, ...checked]));
  }, [criteria]);

  return (
    <BottomSheet
      title={`${workItemType === "project" ? strings.completeWithCriteriaTitle : strings.taskCompleteWithCriteriaTitle}: ${workItem.title}`}
      onClose={onClose}
      labelledBy="complete-with-criteria-title"
    >
      <div className="stack">
        {error ? <p className="capture-error" role="alert">{error}</p> : null}
        <p className="text-muted">
          {workItemType === "project" ? strings.completeWithCriteriaHint : strings.taskCriteriaCompletionHint}
        </p>
        <ul className="criteria-checklist-list">
          {criteria.map((criterion) => (
            <li key={criterion.id} className="criteria-checklist-row">
              <label>
                <input type="checkbox" checked={checkedIds.has(criterion.id)} disabled={busy || criterion.checked} onChange={(event) => setCheckedIds((previous) => {
                  const next = new Set(previous);
                  if (event.target.checked) next.add(criterion.id); else next.delete(criterion.id);
                  return next;
                })} />
                <span className={checkedIds.has(criterion.id) ? "criteria-checklist-text-done" : undefined}>{criterion.text}</span>
              </label>
            </li>
          ))}
        </ul>
        {taskHasOpenDescendants ? (
          <fieldset className="stack">
            <legend>{strings.openChildrenPrompt}</legend>
            <label>
              <input type="radio" name={`complete-child-policy-${workItem.id}`} checked={childPolicy === "leave_open"} disabled={busy} onChange={() => setChildPolicy("leave_open")} />
              {strings.onlyThisTask} – {strings.leaveChildrenOpen}
            </label>
            <label>
              <input type="radio" name={`complete-child-policy-${workItem.id}`} checked={childPolicy === "complete_children"} disabled={busy} onChange={() => setChildPolicy("complete_children")} />
              {strings.completeChildren}
            </label>
            <label>
              <input type="radio" name={`complete-child-policy-${workItem.id}`} checked={childPolicy === "cancel_children"} disabled={busy} onChange={() => setChildPolicy("cancel_children")} />
              {strings.cancelChildren}
            </label>
          </fieldset>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!allChecked || busy || (taskHasOpenDescendants && childPolicy === null)}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onComplete(
                [...checkedIds].filter((id) => !criteria.find((criterion) => criterion.id === id)?.checked),
                taskHasOpenDescendants ? childPolicy ?? undefined : undefined,
              );
              onClose();
            } catch (cause) {
              setError(localizedErrorMessage(cause, strings));
              onRefresh?.();
            } finally {
              setBusy(false);
            }
          }}
        >
          {workItemType === "project" ? strings.completeProjectAction : strings.completeTaskAction}
        </button>
        <button type="button" className="btn btn-block" disabled={busy} onClick={onClose}>
          {strings.close}
        </button>
      </div>
    </BottomSheet>
  );
}
