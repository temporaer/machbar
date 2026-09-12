import type { Task } from "@machbar/shared";
import type { ProjectDetail } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { BottomSheet } from "./BottomSheet";
import { ChildPolicyPrompt } from "./ChildPolicyPrompt";

function isOpenTask(task: Task): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

/**
 * The focused continuation for `story.complete` when acceptance criteria
 * are satisfied (or absent) but open child tasks remain (see
 * `lifecyclePrerequisite()`). Completion stays outcome-based -- not every
 * task must be Done -- but normal completion must not silently leave open
 * work attached, which is exactly what `completed_project_open_work`
 * repairs for legacy/corrupt data. This sheet makes the user explicitly
 * cancel or move every remaining open task before completing, reusing the
 * canonical `useTaskActions().requestCancel` and `task.changeProject`
 * command instead of a bespoke bulk-task endpoint.
 */
export function CompleteWithOpenTasksSheet({
  story,
  onClose,
  onComplete,
}: {
  story: ProjectDetail;
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const dispatch = useWorkItemCommands();

  const openTasks = story.tasks
    .map((task) => taskActions.retained.get(task.id) ?? task)
    .filter(isOpenTask);
  const allResolved = openTasks.length === 0;

  return (
    <BottomSheet
      title={`${strings.completeWithOpenTasksTitle}: ${story.title}`}
      onClose={onClose}
      labelledBy="complete-with-open-tasks-title"
    >
      <div className="stack">
        <p className="text-muted">{strings.completeWithOpenTasksHint}</p>
        {openTasks.length > 0 ? (
          <ul className="open-tasks-reconcile-list">
            {openTasks.map((task) => (
              <li key={task.id} className="open-tasks-reconcile-row">
                <span className="open-tasks-reconcile-title">{task.title}</span>
                <div className="open-tasks-reconcile-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      dispatch({ type: "task.changeProject", taskId: task.id })
                    }
                  >
                    {strings.moveTask}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => taskActions.requestCancel(task)}
                  >
                    {strings.cancelTask}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">{strings.completeWithOpenTasksResolved}</p>
        )}
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!allResolved}
          onClick={async () => {
            await onComplete();
            onClose();
          }}
        >
          {strings.completeProjectAction}
        </button>
        <button type="button" className="btn btn-block" onClick={onClose}>
          {strings.close}
        </button>
      </div>
      {taskActions.pendingTask ? (
        <ChildPolicyPrompt
          taskTitle={taskActions.pendingTask.title}
          action={taskActions.pendingAction ?? "cancel"}
          onChoose={taskActions.resolvePolicy}
          onClose={taskActions.cancelPrompt}
        />
      ) : null}
    </BottomSheet>
  );
}
