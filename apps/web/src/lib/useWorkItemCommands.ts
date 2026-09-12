import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ProjectWithActions } from "./api";
import type { WorkItemCommand } from "./commands";
import { lifecyclePrerequisite } from "./projectWorkflow";
import { useTaskActions } from "./useTaskActions";
import { useProjectActions } from "./useProjectActions";
import { useTaskDetail } from "./taskDetailContext";
import { useTaskWorkflow } from "./taskWorkflowContext";
import { useProjectWorkflow } from "./projectWorkflowContext";
import { useSwipeSettings } from "./swipeSettings";
import { useOptionalInteractionScope } from "./interactionScope";

/**
 * Every `task.*`/`story.*` command carries the id of the WorkItem it
 * targets. Extracting it here lets `dispatch()` update the scope's logical
 * active item generically instead of every call site (click, swipe,
 * checkbox, keyboard) separately calling `scope.setActive(...)` -- see
 * request item 7 ("active item updated consistently by keyboard
 * navigation, clicking/tapping a row, ... swiping/interacting with a
 * row").
 */
function commandWorkItemId(command: WorkItemCommand): number | null {
  switch (command.type) {
    case "task.open":
    case "task.plan":
    case "task.reminders":
    case "task.waitingLifecycle":
    case "task.split":
    case "task.assignOwner":
    case "task.changeProject":
    case "task.changeParent":
    case "task.addSuccessor":
    case "task.recurrence":
    case "task.priority":
    case "task.tags":
    case "task.contexts":
    case "task.convertToProject":
    case "task.lifecycle":
    case "task.setStatus":
    case "task.openOverflow":
    case "task.toggleDone":
    case "task.toggleAdditionalNextAction":
    case "task.primaryAction":
    case "task.discard":
      return "task" in command ? command.task.id : command.taskId;
    case "workItem.schedule":
    case "workItem.setDeadline":
    case "workItem.setRevisitDate":
      return command.item.id;
    case "story.activate":
    case "story.returnToBacklog":
    case "story.complete":
    case "story.reopen":
    case "story.archive":
    case "story.defer":
    case "story.assignDriver":
    case "story.planWork":
    case "story.editOutcome":
    case "story.tags":
    case "story.contexts":
    case "story.lifecycle":
    case "story.openOverflow":
      return command.story.id;
    case "outline.collapse":
    case "outline.expand":
    case "outline.moveUp":
    case "outline.moveDown":
    case "outline.indent":
    case "outline.outdent":
      return command.workItemId;
    default:
      return null;
  }
}

function commandWorkItemRole(command: WorkItemCommand): "task" | "story" | null {
  switch (command.type) {
    case "task.open":
    case "task.plan":
    case "task.reminders":
    case "task.waitingLifecycle":
    case "task.split":
    case "task.assignOwner":
    case "task.changeProject":
    case "task.changeParent":
    case "task.addSuccessor":
    case "task.recurrence":
    case "task.priority":
    case "task.tags":
    case "task.contexts":
    case "task.convertToProject":
    case "task.lifecycle":
    case "task.setStatus":
    case "task.openOverflow":
    case "task.toggleDone":
    case "task.toggleAdditionalNextAction":
    case "task.primaryAction":
    case "task.discard":
      return "task";
    case "story.activate":
    case "story.returnToBacklog":
    case "story.complete":
    case "story.reopen":
    case "story.archive":
    case "story.defer":
    case "story.assignDriver":
    case "story.planWork":
    case "story.editOutcome":
    case "story.tags":
    case "story.contexts":
    case "story.lifecycle":
    case "story.openOverflow":
      return "story";
    case "workItem.schedule":
    case "workItem.setDeadline":
    case "workItem.setRevisitDate":
      return command.item.role;
    default:
      return null;
  }
}

/**
 * Routes `task.*`/`story.*`/`outline.collapse`/`outline.expand`/
 * `navigate.*` semantic commands into the shared `useTaskActions()`/
 * `useProjectActions()`/`useTaskDetail()` controllers and the interaction
 * scope's collapse state — the same controllers every consumer already
 * reads from `App.tsx`'s providers (see `useTaskActions.tsx`/
 * `useProjectActions.tsx`/`interactionScope.tsx`). This hook does not own
 * any state of its own; it is a thin, stable dispatch surface so mouse
 * clicks, swipes, row buttons, and keyboard shortcuts all describe the
 * same intent instead of each calling a different action directly.
 *
 * `outline.moveUp/moveDown/indent/outdent` are intentionally not handled
 * here — see `commands.ts` for why they are dispatched directly against
 * the specific `useOutlineOrganize()` instance that owns the rendered
 * sibling group, via the scope's registered `moveBy`. `outline.collapse`/
 * `outline.expand` carry no such structural-safety risk (folding is pure
 * view state), so they're handled generically here. `capture.open` invokes
 * the opener registered by the scoped `QuickAdd`.
 */
export function useWorkItemCommands() {
  const taskActions = useTaskActions();
  const projectActions = useProjectActions();
  const taskDetail = useTaskDetail();
  const taskWorkflow = useTaskWorkflow();
  const projectWorkflow = useProjectWorkflow();
  const navigate = useNavigate();
  const { primarySwipeAction } = useSwipeSettings();
  const scope = useOptionalInteractionScope();

  /**
   * Opens whatever a lifecycle transition still needs before it can be
   * committed and reports whether the transition itself must wait. Callers
   * dispatch `story.activate`/`story.complete`/`story.reopen` unconditionally;
   * only this function decides that e.g. completing a story with open
   * acceptance criteria means "show me the criteria first".
   */
  const resolveStoryPrerequisite = useCallback(
    (
      story: ProjectWithActions,
      action: "activate" | "complete" | "reopen",
      ownerMemberId?: number | null,
    ): boolean => {
      switch (lifecyclePrerequisite(story, action, ownerMemberId)) {
        case "openCriteria":
          projectWorkflow.open("completeWithCriteria", story.id);
          return true;
        case "progressPath":
          navigate(`/projects/${story.id}?focus=next-action`);
          return true;
        case "driver":
          projectWorkflow.open(
            action === "reopen" ? "reopenWithDriver" : "activateWithDriver",
            story.id,
          );
          return true;
        default:
          return false;
      }
    },
    [navigate, projectWorkflow],
  );

  const dispatch = useCallback(
    (command: WorkItemCommand) => {
      const workItemId = commandWorkItemId(command);
      if (workItemId !== null) scope?.setActive(workItemId, commandWorkItemRole(command));
      switch (command.type) {
        case "task.open":
          taskDetail.open(command.taskId, command.focusField);
          return;
        case "task.plan":
          taskWorkflow.open("plan", command.taskId);
          return;
        case "task.reminders":
          taskWorkflow.open("reminders", command.taskId);
          return;
        case "task.waitingLifecycle":
          taskWorkflow.open("waitingLifecycle", command.taskId);
          return;
        case "task.split":
          taskWorkflow.open("split", command.taskId);
          return;
        case "task.assignOwner":
          taskWorkflow.open("assignOwner", command.taskId);
          return;
        case "task.changeProject":
          taskWorkflow.open("changeProject", command.taskId);
          return;
        case "task.changeParent":
          taskWorkflow.open("changeParent", command.taskId);
          return;
        case "task.addSuccessor":
          taskWorkflow.open("addSuccessor", command.taskId);
          return;
        case "task.recurrence":
          taskWorkflow.open("recurrence", command.taskId);
          return;
        case "task.priority":
          taskWorkflow.open("priority", command.taskId);
          return;
        case "task.tags":
          taskWorkflow.open("tags", command.taskId);
          return;
        case "task.contexts":
          taskWorkflow.open("contexts", command.taskId);
          return;
        case "task.convertToProject":
          taskWorkflow.open("convertToProject", command.taskId);
          return;
        case "task.openOverflow":
          scope?.setOpenOverflow(command.taskId);
          return;
        case "task.lifecycle":
          scope?.setOpenLifecycle(command.taskId);
          return;
        case "task.setStatus": {
          // State-sensitive resolution lives here rather than in each caller:
          // leaving a terminal status is one atomic backend transition, while
          // entering one may need the shared child-policy prompt first.
          const current = command.task.status;
          const next = command.status;
          if (current === next) return;
          if (current === "done" || current === "cancelled") {
            if (next === "actionable") {
              taskActions.requestToggle(command.task);
            } else {
              taskActions.transitionStatus(command.task, next);
            }
            return;
          }
          if (next === "done") {
            taskActions.requestToggle(command.task);
            return;
          }
          if (next === "cancelled") {
            taskActions.requestCancel(command.task);
            return;
          }
          if (next === "captured") {
            taskActions.transitionStatus(command.task, "captured");
            return;
          }
          taskActions.setStatus(command.task, next);
          return;
        }
        case "task.toggleDone":
          taskActions.requestToggle(command.task);
          return;
        case "task.toggleAdditionalNextAction": {
          const nextValue = !command.task.additionalNextAction;
          taskActions.update(
            command.task,
            { additionalNextAction: nextValue },
            { additionalNextAction: nextValue },
          );
          return;
        }
        case "task.primaryAction":
          // The configured primary swipe action (someday/cancel/complete);
          // `requestPrimarySwipe` already resolves reopen/clarify first.
          taskActions.requestPrimarySwipe(command.task, primarySwipeAction);
          return;
        case "task.discard":
          taskActions.requestCancel(command.task);
          return;
        case "workItem.schedule":
          if (command.item.role === "task") {
            return taskActions.update(
              command.item.task,
              { scheduledDate: command.date },
              { scheduledDate: command.date },
              true,
            );
          }
          return projectActions.schedule(command.item.project, {
            scheduledDate: command.date,
          });
        case "workItem.setDeadline":
          if (command.item.role === "task") {
            return taskActions.update(
              command.item.task,
              { dueDate: command.date },
              { dueDate: command.date },
              true,
            );
          }
          return projectActions.schedule(command.item.project, {
            dueDate: command.date,
          });
        case "workItem.setRevisitDate":
          if (command.item.role === "task" && command.item.task.externalWait) {
            return taskActions.setExternalWait(command.item.task, {
              waitingFor: command.item.task.externalWait.waitingFor,
              revisitDate: command.date,
            }, {
              throwOnError: true,
            });
          }
          return;
        case "story.activate":
          if (!resolveStoryPrerequisite(command.story, "activate", command.ownerMemberId)) {
            void projectActions.activate(command.story, command.ownerMemberId);
          }
          return;
        case "story.returnToBacklog":
          void projectActions.runAction(command.story, "return_to_backlog");
          return;
        case "story.complete":
          if (!resolveStoryPrerequisite(command.story, "complete")) {
            void projectActions.runAction(command.story, "complete");
          }
          return;
        case "story.reopen":
          if (!resolveStoryPrerequisite(command.story, "reopen", command.ownerMemberId)) {
            void projectActions.runAction(command.story, "reopen", command.ownerMemberId);
          }
          return;
        case "story.archive":
          void projectActions.runAction(command.story, "archive");
          return;
        case "story.defer":
          projectWorkflow.open("defer", command.story.id);
          return;
        case "story.assignDriver":
          projectWorkflow.open("assignDriver", command.story.id);
          return;
        case "story.editOutcome":
          projectWorkflow.open("editOutcome", command.story.id);
          return;
        case "story.planDates":
          projectWorkflow.open("planDates", command.story.id);
          return;
        case "story.tags":
          projectWorkflow.open("tags", command.story.id);
          return;
        case "story.contexts":
          projectWorkflow.open("contexts", command.story.id);
          return;
        case "story.planWork":
          navigate(`/projects/${command.story.id}?focus=next-action`);
          return;
        case "story.lifecycle":
          scope?.setOpenLifecycle(command.story.id);
          return;
        case "story.openOverflow":
          scope?.setOpenOverflow(command.story.id);
          return;
        case "outline.collapse":
          scope?.setCollapsed(command.workItemId, true);
          return;
        case "outline.expand":
          scope?.setCollapsed(command.workItemId, false);
          return;
        case "navigate.today":
          navigate("/today");
          return;
        case "navigate.inbox":
          navigate("/inbox");
          return;
        case "navigate.projects":
          navigate("/projects");
          return;
        case "navigate.waiting":
          navigate("/waiting");
          return;
        case "navigate.more":
          navigate("/more");
          return;
        case "capture.open":
          scope?.captureOpen?.();
          return;
        case "outline.moveUp":
        case "outline.moveDown":
        case "outline.indent":
        case "outline.outdent":
          // Not dispatched here — see the module comment above.
          return;
      }
    },
    [
      taskActions,
      projectActions,
      taskDetail,
      taskWorkflow,
      projectWorkflow,
      navigate,
      primarySwipeAction,
      scope,
      resolveStoryPrerequisite,
    ],
  );

  return dispatch;
}
