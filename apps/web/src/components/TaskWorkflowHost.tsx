import { useEffect } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useTaskActions } from "../lib/useTaskActions";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useIdentity } from "../lib/identity";
import { MemberSelectionSheet } from "./MemberSelectionSheet";
import { MoveTaskSheet } from "./MoveTaskSheet";
import { TaskPlanSheet } from "./TaskPlanSheet";
import { TaskWaitSheet } from "./TaskWaitSheet";
import { WaitingFollowUpSheet } from "./WaitingFollowUpSheet";
import { TaskSplitSheet } from "./TaskSplitSheet";
import { TaskSuccessorSheet } from "./TaskSuccessorSheet";
import { TaskRecurrenceSheet } from "./TaskRecurrenceSheet";
import { TaskPrioritySheet } from "./TaskPrioritySheet";
import { TaskTagsSheet } from "./TaskTagsSheet";
import { TaskContextsSheet } from "./TaskContextsSheet";
import { TaskConvertToProjectSheet } from "./TaskConvertToProjectSheet";
import { useStrings } from "../lib/strings";

/**
 * The single host for every focused task workflow reachable through a
 * canonical `task.*` command (see `taskWorkflowContext.tsx`) — the one
 * place that imports every one of these sheets and decides which to
 * render. `useWorkItemCommands()` is the only place that calls
 * `taskWorkflow.open(...)`; rows, keyboard handlers, Review, and detail
 * value clicks all just `dispatch()` and never render a sheet themselves.
 *
 * Fetches the task itself (like `TaskDetailSheet` already does) so
 * id-only callers work identically to callers that already have the
 * `Task` object in hand — see `App.tsx`, mounted once alongside
 * `TaskDetailSheet`.
 */
export function TaskWorkflowHost() {
  const workflow = useTaskWorkflow();
  const strings = useStrings();
  const { members } = useIdentity();
  const taskActions = useTaskActions();
  const taskId = workflow.current?.taskId ?? null;
  const { data: fetchedTask, reload } = useAsync(
    () => (taskId !== null ? api.getTask(taskId) : Promise.resolve(null)),
    [taskId],
  );
  const retained = taskId !== null ? taskActions.retained.get(taskId) : undefined;
  const task = retained ?? fetchedTask;

  useEffect(() => {
    if (taskId !== null) reload();
  }, [taskId, reload]);

  if (!workflow.current || !task) return null;
  const close = workflow.close;

  switch (workflow.current.kind) {
    case "plan":
      return <TaskPlanSheet task={task} onClose={close} />;
    case "waitingLifecycle":
      return task.externalWait ? (
        <WaitingFollowUpSheet task={task} onClose={close} />
      ) : (
        <TaskWaitSheet task={task} onClose={close} />
      );
    case "split":
      return <TaskSplitSheet parentId={task.id} parentTitle={task.title} onClose={close} />;
    case "assignOwner":
      return (
        <MemberSelectionSheet
          title={`${strings.assign}: ${task.title}`}
          label={strings.owner}
          idPrefix={`task-workflow-owner-${task.id}`}
          members={members}
          value={task.effectiveOwnerId}
          valueIsExplicit={task.effectiveOwnerSource === "task"}
          unassignedLabel={strings.shared}
          onClose={close}
          onSelect={async (ownerMemberId) => {
            await taskActions.assignOwner(task, ownerMemberId);
          }}
        />
      );
    case "changeProject":
      return <MoveTaskSheet task={task} mode="subtree" onClose={close} />;
    case "addSuccessor":
      return <TaskSuccessorSheet task={task} onClose={close} />;
    case "recurrence":
      return <TaskRecurrenceSheet task={task} onClose={close} />;
    case "priority":
      return <TaskPrioritySheet task={task} onClose={close} />;
    case "tags":
      return <TaskTagsSheet task={task} onClose={close} />;
    case "contexts":
      return <TaskContextsSheet task={task} onClose={close} />;
    case "convertToProject":
      return <TaskConvertToProjectSheet task={task} onClose={close} />;
    default:
      return null;
  }
}
