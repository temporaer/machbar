import { useRetentionInteraction } from "../lib/useRetentionInteraction";
import { useEffect, useRef } from "react";
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
import { BottomSheet } from "./BottomSheet";
import { ErrorState, LoadingState, ReadErrorState } from "./AsyncStates";
import { isWorkItemAccessError } from "../lib/errorMessage";

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
  const opening = useRef<{ state: TaskWorkflowState | null; opener: HTMLElement | null }>({ state: null, opener: null });
  if (opening.current.state !== state) {
    opening.current = { state, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null };
  }
  const taskRead = useAsync(
    () => (taskId !== null ? api.getTask(taskId) : Promise.resolve(null)),
    [state, taskActions.scopeToken],
  );
  const fetchedTask = taskRead.data;
  useRetentionInteraction(taskId, taskActions.pauseRetention, taskId !== null);
  const retained = taskId !== null ? taskActions.retained.get(taskId) : undefined;
  const accessLost = isWorkItemAccessError(taskRead.errorCause) || isWorkItemAccessError(taskRead.refreshErrorCause);
  const confirmed = taskId !== null ? taskActions.getConfirmedTask(taskId) : undefined;
  const input = fetchedTask ?? confirmed;
  const task = accessLost ? null : input ? taskActions.projectTask(input) : retained ?? null;
  useEffect(() => {
    if (taskId === null) return;
    if (accessLost) taskActions.invalidateConfirmedTask(taskId);
    else if (fetchedTask && taskRead.error === null && taskRead.refreshError === null) taskActions.observeConfirmedTask(fetchedTask, true);
  }, [taskId, accessLost, fetchedTask, taskRead.error, taskRead.refreshError, taskActions.invalidateConfirmedTask, taskActions.observeConfirmedTask]);

  if (!state) return null;
  const close = () => workflow.close(state);
  const reload = () => {
    if (workflow.isCurrent(state) && taskActions.isCurrentScope(taskActions.scopeToken)) taskRead.reload();
  };
  const sheetProps = {
    onClose: close,
    suspended,
    restoreFocusTo: opening.current.opener,
    headerStatus: taskRead.loading || taskRead.error !== null || taskRead.refreshError !== null ? <>
      {taskRead.loading ? <LoadingState /> : null}
      <ReadErrorState resource={task?.title ?? strings.task} {...taskRead} reload={reload} />
    </> : null,
  };
  if (!task) {
    const titles: Record<TaskWorkflowState["kind"], string> = {
      plan: strings.planning, availability: strings.planning, waitingLifecycle: strings.planning,
      deferClarification: strings.clarificationRevisitTitle, structure: strings.structure,
      split: strings.splitTask, refinement: strings.workRefinement, assignOwner: strings.assign,
      changeProject: strings.structureMove, priority: strings.priority, tags: strings.tags,
      contexts: strings.physicalContexts, convertToProject: strings.structureConvertToProject,
      completeWithCriteria: strings.taskCompleteWithCriteriaTitle,
    };
    return <BottomSheet {...sheetProps} title={titles[state.kind]}>
      {!taskRead.loading && taskRead.error === null && taskRead.refreshError === null
        ? <ErrorState message={strings.workflowTargetUnavailable} onRetry={reload} /> : null}
    </BottomSheet>;
  }

  switch (state.kind) {
    case "plan":
      return (
        <TaskPlanningSheet
          {...sheetProps}
          key={task.id}
          task={task}
          {...(state.planningTarget
            ? { initialTarget: state.planningTarget }
            : {})}
        />
      );
    case "availability":
      return <TaskPlanningSheet {...sheetProps} key={task.id} task={task} initialTarget="availability" />;
    case "deferClarification":
      return <TaskClarificationSheet {...sheetProps} task={task} />;
    case "structure":
      return <TaskStructureSheet {...sheetProps} task={task} />;
    case "waitingLifecycle":
      return <TaskPlanningSheet {...sheetProps} key={task.id} task={task} initialTarget="waiting" />;
    case "split":
      return (
        <TaskSplitSheet
          {...sheetProps}
          key={task.id}
          parentId={task.id}
          parentTitle={task.title}
          parentRevision={task.revision}
          parentStatus={task.status}
          projectId={task.projectId}
          existingChildren={task.children}
        />
      );
    case "refinement":
      return <WorkClarificationSheet {...sheetProps} targetType="task" targetId={task.id} revision={task.revision} title={task.title} task={task} onStarted={(intakeId) => {
        if (!workflow.isCurrent(state) || !taskActions.isCurrentScope(taskActions.scopeToken)) return;
        const detail = taskDetail.openTaskId === task.id ? taskDetail.suspendForHandoff() : null;
        const refinementOrigin: WorkRefinementOrigin = { targetType: "task", targetId: task.id, originPath: `${location.pathname}${location.search}`, entry: detail ? "task_detail" : "page", taskDetail: detail };
        close();
        navigate(`/intake/${intakeId}`, { state: { refinementOrigin } });
      }} />;
    case "assignOwner":
      return (
        <TaskOwnerSheet
          {...sheetProps}
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
      return <MoveTaskSheet {...sheetProps} task={task} />;
    case "priority":
      return <TaskPrioritySheet {...sheetProps} task={task} />;
    case "tags":
      return <TaskTagsSheet {...sheetProps} task={task} />;
    case "contexts":
      return <TaskContextsSheet {...sheetProps} task={task} />;
    case "convertToProject":
      return <TaskConvertToProjectSheet {...sheetProps} key={task.id} task={task} />;
    case "completeWithCriteria":
      return (
        <CompleteWithCriteriaSheet
          {...sheetProps}
          workItem={task}
          workItemType="task"
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
