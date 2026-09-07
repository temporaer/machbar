import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { WorkItemCommand } from "./commands";
import { useTaskActions } from "./useTaskActions";
import { useProjectActions } from "./useProjectActions";
import { useTaskDetail } from "./taskDetailContext";
import { useSwipeSettings } from "./swipeSettings";

/**
 * Routes `task.*`/`story.*`/`navigate.*` semantic commands into the shared
 * `useTaskActions()`/`useProjectActions()`/`useTaskDetail()` controllers —
 * the same controllers every consumer already reads from `App.tsx`'s
 * providers (see `useTaskActions.tsx`/`useProjectActions.tsx`). This hook
 * does not own any state of its own; it is a thin, stable dispatch surface
 * so mouse clicks, swipes, row buttons, and (Phase 5) keyboard shortcuts
 * all describe the same intent instead of each calling a different
 * action directly.
 *
 * `outline.*` commands are intentionally not handled here — see
 * `commands.ts` for why they are dispatched directly against the specific
 * `useOutlineOrganize()` instance that owns the rendered sibling group.
 * `capture.open` is not yet wired (no capture-target registry exists
 * until the Phase 4 interaction scope lands); dispatching it today is a
 * no-op.
 */
export function useWorkItemCommands() {
  const taskActions = useTaskActions();
  const projectActions = useProjectActions();
  const taskDetail = useTaskDetail();
  const navigate = useNavigate();
  const { primarySwipeAction } = useSwipeSettings();

  const dispatch = useCallback(
    (command: WorkItemCommand) => {
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
        case "outline.collapse":
        case "outline.expand":
        case "outline.moveUp":
        case "outline.moveDown":
        case "outline.indent":
        case "outline.outdent":
          // Not dispatched here — see the module comment above.
          return;
      }
    },
    [taskActions, projectActions, taskDetail, navigate, primarySwipeAction],
  );

  return dispatch;
}
