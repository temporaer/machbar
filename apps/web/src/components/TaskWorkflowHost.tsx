import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useTaskActions } from "../lib/useTaskActions";
import { useTaskWorkflow, type TaskWorkflowState } from "../lib/taskWorkflowContext";
import { MoveTaskSheet } from "./MoveTaskSheet";
import { TaskOwnerSheet } from "./TaskOwnerSheet";
import { TaskPlanningSheet } from "./TaskPlanningSheet";
import { TaskStructureSheet } from "./TaskStructureSheet";
import { discardTaskSplitDraft, TaskSplitSheet } from "./TaskSplitSheet";
import { WorkClarificationSheet } from "./WorkClarificationSheet";
import { TaskPrioritySheet } from "./TaskPrioritySheet";
import { TaskTagsSheet } from "./TaskTagsSheet";
import { TaskContextsSheet } from "./TaskContextsSheet";
import { TaskConvertToProjectSheet } from "./TaskConvertToProjectSheet";
import { CompleteWithCriteriaSheet } from "./CompleteWithCriteriaSheet";
import { TaskClarificationSheet } from "./TaskClarificationSheet";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useTaskDetail, type WorkRefinementOrigin } from "../lib/taskDetailContext";
import { BottomSheet } from "./BottomSheet";
import { isReadAccessError, isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";

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
  const location = useLocation();
  const navigationType = useNavigationType();
  const previousLocationKey = useRef(location.key);
  const { currentMemberId } = useIdentity();
  const previousOpenTaskId = useRef(taskDetail.openTaskId);
  useEffect(() => {
    const locationChanged = previousLocationKey.current !== location.key;
    if (locationChanged) {
      previousLocationKey.current = location.key;
      if (!workflow.detailClosing) {
        const refinementReturn =
          workflow.navigationIntent === "refinement" && navigationType === "REPLACE";
        const inspection = workflow.detailInspection;
        workflow.historyChanged(location.key, navigationType);
        if (refinementReturn) {
          taskDetail.resumeAfterHandoff();
        } else if (inspection) {
          if (navigationType === "POP" && location.key === inspection.originKey) {
            taskDetail.resumeAfterHandoff();
          } else if (taskDetail.openTaskId !== null) {
            taskDetail.suspendForHandoff();
          }
        }
      }
    }
    if (workflow.current === null && workflow.detailReturn) {
      taskDetail.resumeAfterHandoff(workflow.detailReturn);
      workflow.consumeDetailReturn();
    } else if (
      workflow.current !== null &&
      taskDetail.openTaskId === null &&
      taskDetail.suspended &&
      (workflow.detailInspection === null || workflow.detailVisible)
    ) {
      taskDetail.resumeAfterHandoff();
    }
    const previousTaskId = previousOpenTaskId.current;
    previousOpenTaskId.current = taskDetail.openTaskId;
    if (
      previousTaskId !== null &&
      taskDetail.openTaskId === null &&
      workflow.detailInspection &&
      workflow.detailVisible &&
      !taskDetail.suspended
    ) {
      workflow.closeDetail();
    }
  }, [
    location.key,
    navigationType,
    taskDetail.openTaskId,
    taskDetail.suspended,
    workflow,
  ]);
  // Each planning slot keeps its React position when another prerequisite is
  // inspected. Only the foreground operation registers a visible modal.
  const retained = workflow.detailInspections;
  const retainedIds = new Set(retained.map((inspection) => inspection.openingId));
  const currentIsRetained =
    workflow.current !== null &&
    workflow.current === workflow.detailInspection?.planningWorkflow;
  const entries = [
    ...retained.map((inspection) => ({
      openingId: inspection.openingId,
      state: inspection.planningWorkflow,
      retained: true,
    })),
    ...(workflow.current && workflow.currentOpeningId !== null &&
    !currentIsRetained &&
    !retainedIds.has(workflow.currentOpeningId)
      ? [{
          openingId: workflow.currentOpeningId,
          state: workflow.current,
          retained: false,
        }]
      : []),
  ];
  return <>
    {entries.map(({ openingId, state, retained: isRetained }) => {
      const resumedRetained =
        isRetained &&
        openingId === workflow.currentOpeningId &&
        workflow.detailInspection !== null &&
        workflow.detailVisible &&
        workflow.detailClosing &&
        taskDetail.openTaskId === null &&
        !taskDetail.suspended;
      const suspended = (isRetained && !resumedRetained) || (
        workflow.detailInspection !== null &&
        (workflow.navigationIntent === "refinement" ||
          (location.key !== workflow.detailInspection.originKey && !workflow.detailVisible) ||
          (isRetained && taskDetail.suspended))
      );
      return <TaskWorkflowContent
        key={`${currentMemberId}:${openingId}`}
        state={state}
        suspended={suspended}
        openingId={openingId}
      />;
    })}
  </>;
}

function TaskWorkflowContent({ state, suspended = false, openingId }: {
  state: TaskWorkflowState;
  suspended?: boolean;
  openingId: number;
}) {
  const workflow = useTaskWorkflow();
  const strings = useStrings();
  const { members, currentMemberId } = useIdentity();
  const taskActions = useTaskActions();
  const taskDetail = useTaskDetail();
  const location = useLocation();
  const navigate = useNavigate();
  const taskId = state.taskId;
  const [endedError, setEndedError] = useState<string | null>(null);
  const [requirementsEpoch, setRequirementsEpoch] = useState(0);
  const ended = useRef(false);
  const mounted = useRef(false);
  const currentOpeningId = useRef(workflow.currentOpeningId);
  currentOpeningId.current = workflow.currentOpeningId;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isOpeningCurrent = () =>
    currentOpeningId.current === openingId;
  const isCurrent = () => mounted.current && isOpeningCurrent();
  const endOnDenied = (cause: unknown) => {
    if (isCurrent() && isReadAccessError(cause)) {
      if (state.kind === "split") discardTaskSplitDraft(taskId, currentMemberId);
      ended.current = true;
      setEndedError(localizedErrorMessage(cause, strings));
    }
  };
  const run = async (command: () => Promise<unknown>) => {
    try {
      await command();
    } catch (cause) {
      endOnDenied(cause);
      if (isCurrent() && !ended.current && state.kind === "completeWithCriteria" &&
        isStaleWriteConflict(cause)) {
        setRequirementsEpoch((value) => value + 1);
      }
      throw cause;
    }
  };
  const { data: task, loading, error, reload } = useAsync(
    async (signal) => {
      if (ended.current) return null;
      try {
        return await api.getTask(taskId);
      } catch (cause) {
        if (!signal.aborted) endOnDenied(cause);
        throw cause;
      }
    },
    [taskId, requirementsEpoch],
  );
  const dismiss = () => { if (isCurrent()) workflow.close(); };
  const close = () => { if (!ended.current) dismiss(); };
  if (!endedError && !task && loading) return suspended ? null : <p role="status">{strings.loading}</p>;
  if (endedError || !task) {
    if (suspended) return null;
    return <BottomSheet title={strings.error} onClose={dismiss}>
      <div className="stack">
        {endedError || error ? <p role="alert">{endedError ?? error}</p> : requirementsEpoch > 0 ? <p role="alert">{strings.activationRequirementsChanged}</p> : null}
        {!endedError && loading ? <p role="status">{strings.loading}</p> : null}
        {!endedError && error ? <button className="btn" onClick={reload}>{strings.retry}</button> : null}
        <button className="btn" onClick={dismiss}>{strings.close}</button>
      </div>
    </BottomSheet>;
  }

  switch (state.kind) {
    case "plan":
      return (
        <TaskPlanningSheet
          key={task.id}
          task={task}
          suspended={suspended}
          onClose={close}
          onFailure={endOnDenied}
          {...(state.planningTarget
            ? { initialTarget: state.planningTarget }
            : {})}
        />
      );
    case "availability":
      return <TaskPlanningSheet key={task.id} task={task} suspended={suspended} onClose={close} onFailure={endOnDenied} initialTarget="availability" />;
    case "deferClarification":
      return <TaskClarificationSheet task={task} onClose={close} onFailure={endOnDenied} />;
    case "structure":
      return <TaskStructureSheet task={task} onClose={close} />;
    case "waitingLifecycle":
      return <TaskPlanningSheet key={task.id} task={task} suspended={suspended} onClose={close} onFailure={endOnDenied} initialTarget="waiting" />;
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
          onFailure={endOnDenied}
          isCurrent={() => isCurrent() && !ended.current}
        />
      );
    case "refinement":
      return <WorkClarificationSheet targetType="task" targetId={task.id} revision={task.revision} title={task.title} task={task} onClose={close} onFailure={endOnDenied} onStarted={(intakeId) => {
        if (!isCurrent() || ended.current) return;
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
            await run(() => taskActions.assignOwner(
              task,
              ownerMemberId,
              ownerInheritanceMode,
              cleanedTitle && cleanedTitle !== task.title
                ? { title: cleanedTitle }
                : {},
            ));
          }}
        />
      );
    case "changeProject":
      return <MoveTaskSheet task={task} onClose={close} onFailure={endOnDenied} isCurrent={() => isCurrent() && !ended.current} />;
    case "priority":
      return <TaskPrioritySheet task={task} onClose={close} onFailure={endOnDenied} />;
    case "tags":
      return <TaskTagsSheet task={task} onClose={close} onFailure={endOnDenied} />;
    case "contexts":
      return <TaskContextsSheet task={task} onClose={close} onFailure={endOnDenied} />;
    case "convertToProject":
      return <TaskConvertToProjectSheet key={task.id} task={task} onClose={close} onFailure={endOnDenied} isCurrent={() => isCurrent() && !ended.current} />;
    case "completeWithCriteria":
      return (
        <CompleteWithCriteriaSheet
          workItem={task}
          workItemType="task"
          onClose={close}
          onRefresh={reload}
          onComplete={async (criteriaToCheck, childPolicy) => {
            await run(() => taskActions.complete(task, childPolicy, criteriaToCheck, true));
          }}
        />
      );
    default:
      return null;
  }
}
