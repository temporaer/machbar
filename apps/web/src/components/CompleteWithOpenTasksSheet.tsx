import { useEffect, useState } from "react";
import type { AcceptanceCriterion, Task } from "@machbar/shared";
import type { ProjectDetail, ProjectWorkflowInput } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

type Resolution = NonNullable<ProjectWorkflowInput["descendantResolutions"]>[number]["action"];

function openActionBranches(tasks: readonly Task[]): Task[] {
  const branches: Task[] = [];
  const visit = (task: Task, openActionAncestor: boolean) => {
    const openAction = task.kind === "action" && task.status !== "done" && task.status !== "cancelled";
    if (openAction && !openActionAncestor) branches.push(task);
    for (const child of task.children) visit(child, openActionAncestor || openAction);
  };
  for (const task of tasks) visit(task, false);
  return branches;
}

function flattenTasks(tasks: readonly Task[]): Task[] {
  return tasks.flatMap((task) => [task, ...flattenTasks(task.children)]);
}

/** One local decision sheet; every child choice and criterion check is sent
 * with the project completion command and committed in that transaction. */
export function CompleteWithOpenTasksSheet({
  story,
  onClose,
  onComplete,
  onRefresh,
}: {
  story: ProjectDetail;
  onClose: () => void;
  onComplete: (input: ProjectWorkflowInput) => Promise<void>;
  onRefresh?: () => void;
}) {
  const strings = useStrings();
  const branches = openActionBranches(story.tasks);
  const taskSnapshot = flattenTasks(story.tasks).map(({ id, revision }) => ({ taskId: id, revision }));
  const unchecked = (story.acceptanceCriteria ?? []).filter((criterion) => !criterion.checked);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set((story.acceptanceCriteria ?? []).filter((criterion) => criterion.checked).map((criterion) => criterion.id)));
  const [resolutions, setResolutions] = useState<Record<number, Resolution>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = unchecked.every((criterion) => checkedIds.has(criterion.id)) && branches.every((task) => resolutions[task.id] !== undefined);
  const criteria = story.acceptanceCriteria ?? [];
  useEffect(() => {
    const checked = criteria.filter((criterion) => criterion.checked).map((criterion) => criterion.id);
    setCheckedIds((previous) => new Set([...previous, ...checked]));
  }, [criteria]);

  return (
    <BottomSheet title={`${strings.completeProjectAction}: ${story.title}`} onClose={() => { if (!busy) onClose(); }}>
      <div className="stack">
        {criteria.length > 0 ? (
          <section className="stack">
            <p className="text-muted">{strings.completeWithCriteriaHint}</p>
            <ul className="criteria-checklist-list">
              {criteria.map((criterion: AcceptanceCriterion) => (
                <li key={criterion.id} className="criteria-checklist-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={checkedIds.has(criterion.id)}
                      disabled={busy || criterion.checked}
                      onChange={(event) => setCheckedIds((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(criterion.id); else next.delete(criterion.id);
                        return next;
                      })}
                    />
                    <span>{criterion.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : <p className="text-muted">{strings.completeWithOpenTasksResolved}</p>}
        {branches.length > 0 ? (
          <section className="stack">
            <p className="text-muted">{strings.completeWithOpenTasksHint}</p>
            <p className="text-muted">{strings.completeWithOpenTasksBranchHint}</p>
            <ul className="open-tasks-reconcile-list">
              {branches.map((task) => (
                <li key={task.id} className="open-tasks-reconcile-row">
                  <span className="open-tasks-reconcile-title">{task.title}</span>
                  <div className="open-tasks-reconcile-actions">
                    <button type="button" className={`btn btn-sm${resolutions[task.id] === "move_to_inbox" ? " btn-primary" : ""}`} disabled={busy} aria-pressed={resolutions[task.id] === "move_to_inbox"} onClick={() => setResolutions((current) => ({ ...current, [task.id]: "move_to_inbox" }))}>{strings.moveTaskToInbox}</button>
                    <button type="button" className={`btn btn-sm${resolutions[task.id] === "cancel" ? " btn-danger" : ""}`} disabled={busy} aria-pressed={resolutions[task.id] === "cancel"} onClick={() => setResolutions((current) => ({ ...current, [task.id]: "cancel" }))}>{strings.cancelTask}</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {error ? <p className="capture-error" role="alert">{error}</p> : null}
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!ready || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onComplete({
                expectedRevision: story.revision,
                criteriaToCheck: [...checkedIds].filter((id) => unchecked.some((criterion) => criterion.id === id)),
                expectedTaskRevisions: taskSnapshot,
                descendantResolutions: branches.map((task) => ({ taskId: task.id, action: resolutions[task.id]!, expectedRevision: task.revision })),
              });
              onClose();
            } catch (cause) {
              setError(localizedErrorMessage(cause, strings));
              onRefresh?.();
            } finally {
              setBusy(false);
            }
          }}
        >{strings.completeProjectAction}</button>
        <button type="button" className="btn btn-block" disabled={busy} onClick={onClose}>{strings.close}</button>
      </div>
    </BottomSheet>
  );
}
