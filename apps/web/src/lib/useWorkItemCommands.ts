import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { WorkItemCommand } from "./commands";
import { useTaskActions } from "./useTaskActions";
import { useProjectActions } from "./useProjectActions";
import { useTaskDetail } from "./taskDetailContext";
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
    case "task.toggleDone":
    case "task.primaryAction":
    case "task.discard":
      return "task" in command ? command.task.id : command.taskId;
    case "workItem.schedule":
    case "workItem.setDeadline":
      return command.item.id;
    case "story.activate":
    case "story.returnToBacklog":
    case "story.complete":
    case "story.reopen":
    case "story.archive":
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
    case "task.toggleDone":
    case "task.primaryAction":
    case "task.discard":
      return "task";
    case "story.activate":
    case "story.returnToBacklog":
    case "story.complete":
    case "story.reopen":
    case "story.archive":
      return "story";
    case "workItem.schedule":
    case "workItem.setDeadline":
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
  const navigate = useNavigate();
  const { primarySwipeAction } = useSwipeSettings();
  const scope = useOptionalInteractionScope();

  const dispatch = useCallback(
    (command: WorkItemCommand) => {
      const workItemId = commandWorkItemId(command);
      if (workItemId !== null) scope?.setActive(workItemId, commandWorkItemRole(command));
      switch (command.type) {
        case "task.open":
          taskDetail.open(command.taskId, command.focusField);
          return;
        case "task.toggleDone":
          taskActions.requestToggle(command.task);
          return;
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
        case "story.activate":
          void projectActions.activate(command.story, command.ownerMemberId);
          return;
        case "story.returnToBacklog":
          void projectActions.runAction(command.story, "return_to_backlog");
          return;
        case "story.complete":
          void projectActions.runAction(command.story, "complete");
          return;
        case "story.reopen":
          void projectActions.runAction(command.story, "reopen", command.ownerMemberId);
          return;
        case "story.archive":
          void projectActions.runAction(command.story, "archive");
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
    [taskActions, projectActions, taskDetail, navigate, primarySwipeAction, scope],
  );

  return dispatch;
}
