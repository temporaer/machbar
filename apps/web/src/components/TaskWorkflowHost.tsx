import { useRetentionInteraction } from "../lib/useRetentionInteraction";
import { useEffect } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useTaskActions } from "../lib/useTaskActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { useTaskWorkflow, type TaskWorkflowState } from "../lib/taskWorkflowContext";
import { MoveTaskSheet } from "./MoveTaskSheet";
import { TaskOwnerSheet } from "./TaskOwnerSheet";
import { TaskPlanningSheet } from "./TaskPlanningSheet";
import { TaskStructureSheet } from "./TaskStructureSheet";
import { TaskSplitSheet } from "./TaskSplitSheet";
import { WorkClarificationSheet } from "./WorkClarificationSheet";
import { TaskPrioritySheet } from "./TaskPrioritySheet";
import { TaskTagsSheet } from "./TaskTagsSheet";
import { TaskContextsSheet } from "./TaskContextsSheet";
import { TaskConvertToProjectSheet } from "./TaskConvertToProjectSheet";
import { CompleteWithCriteriaSheet } from "./CompleteWithCriteriaSheet";
import { TaskClarificationSheet } from "./TaskClarificationSheet";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useLocation, useNavigate } from "react-router-dom";
import { useTaskDetail, type WorkRefinementOrigin } from "../lib/taskDetailContext";

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
  const taskDetail = useTaskDetail();
  useEffect(() => {
    if (workflow.detailInspection && taskDetail.openTaskId === null) {
      const previous = workflow.detailInspection.previousDetail;
      if (previous) taskDetail.resumeAfterHandoff(previous);
      workflow.resumeFromDetail();
    }
  }, [workflow.detailInspection, taskDetail.openTaskId]);
  // Each planning slot keeps its React position when another prerequisite is
  // inspected. Only the foreground operation registers a visible modal.
  const retained = workflow.detailInspections;
  const foreground = workflow.current === workflow.detailInspection?.planningWorkflow
    ? null : workflow.current;
  return <>
    {[...retained.map((inspection) => inspection.planningWorkflow), foreground].map((state, index) =>
      <TaskWorkflowContent key={index} state={state} suspended={index < retained.length} />)}
  </>;
}

function TaskWorkflowContent({ state, suspended = false }: { state: TaskWorkflowState | null; suspended?: boolean }) {
  const workflow = useTaskWorkflow();
  const strings = useStrings();
  const { members } = useIdentity();
  const taskActions = useTaskActions();
  const taskDetail = useTaskDetail();
  const location = useLocation();
  const navigate = useNavigate();
  const dispatch = useWorkItemCommands();
  const taskId = state?.taskId ?? null;
  const { data: fetchedTask, reload } = useAsync(
    () => (taskId !== null ? api.getTask(taskId) : Promise.resolve(null)),
    [taskId],
  );
  useRetentionInteraction(taskId, taskActions.pauseRetention, taskId !== null);
  const retained = taskId !== null ? taskActions.retained.get(taskId) : undefined;
  const task = fetchedTask ? taskActions.projectTask(fetchedTask) : retained ?? null;

  useEffect(() => {
    if (taskId !== null) reload();
  }, [taskId, reload]);

  if (!state || !task) return null;
  const close = workflow.close;

  switch (state.kind) {
    case "plan":
      return (
        <TaskPlanningSheet
          key={task.id}
          task={task}
          suspended={suspended}
          onClose={close}
          {...(state.planningTarget
            ? { initialTarget: state.planningTarget }
            : {})}
        />
      );
    case "availability":
      return <TaskPlanningSheet key={task.id} task={task} suspended={suspended} onClose={close} initialTarget="availability" />;
    case "deferClarification":
      return <TaskClarificationSheet task={task} onClose={close} />;
    case "structure":
      return <TaskStructureSheet task={task} onClose={close} />;
    case "waitingLifecycle":
      return <TaskPlanningSheet key={task.id} task={task} suspended={suspended} onClose={close} initialTarget="waiting" />;
    case "split":
      return (
        <TaskSplitSheet
          key={task.id}
          parentId={task.id}
          parentTitle={task.title}
          parentRevision={task.revision}
          parentStatus={task.status}
          projectId={task.projectId}
          existingChildren={task.children}
          onClose={close}
        />
      );
    case "refinement":
      return <WorkClarificationSheet targetType="task" targetId={task.id} revision={task.revision} title={task.title} task={task} onClose={close} onStarted={(intakeId) => {
        const detail = taskDetail.openTaskId === task.id ? taskDetail.suspendForHandoff() : null;
        const refinementOrigin: WorkRefinementOrigin = { targetType: "task", targetId: task.id, originPath: `${location.pathname}${location.search}`, entry: detail ? "task_detail" : "page", taskDetail: detail };
        close();
        navigate(`/intake/${intakeId}`, { state: { refinementOrigin } });
      }} />;
    case "assignOwner":
      return (
        <TaskOwnerSheet
          title={`${strings.assign}: ${task.title}`}
          taskTitle={task.title}
          createdAt={task.createdAt}
          members={members}
          ownerMemberId={task.ownerMemberId}
          ownerInheritanceMode={task.ownerInheritanceMode}
          inheritedOwnerId={task.inheritedOwnerId}
          inheritanceSource={
            task.inheritedOwnerId === null
              ? null
              : task.parentTaskId !== null
                ? "parent"
                : "project"
          }
          onClose={close}
          onSelect={async ({ ownerMemberId, ownerInheritanceMode }, cleanedTitle) => {
            await taskActions.assignOwner(
              task,
              ownerMemberId,
              ownerInheritanceMode,
              cleanedTitle && cleanedTitle !== task.title
                ? { title: cleanedTitle }
                : {},
            );
          }}
        />
      );
    case "changeProject":
      return <MoveTaskSheet task={task} onClose={close} />;
    case "priority":
      return <TaskPrioritySheet task={task} onClose={close} />;
    case "tags":
      return <TaskTagsSheet task={task} onClose={close} />;
    case "contexts":
      return <TaskContextsSheet task={task} onClose={close} />;
    case "convertToProject":
      return <TaskConvertToProjectSheet key={task.id} task={task} onClose={close} />;
    case "completeWithCriteria":
      return (
        <CompleteWithCriteriaSheet
          workItem={task}
          workItemType="task"
          onClose={close}
          onRefresh={reload}
          onComplete={async (criteriaToCheck, childPolicy) => {
            await taskActions.complete(task, childPolicy, criteriaToCheck, true);
          }}
        />
      );
    default:
      return null;
  }
}
