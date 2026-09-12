import type { Task } from "@machbar/shared";
import type { ProjectWithActions, WeekPlanningItem } from "./api";
import type { TaskDetailFocusField } from "./taskDetailContext";
import type { ProjectWorkflowAction } from "./api";

/**
 * The semantic command vocabulary every interaction surface dispatches
 * against — mouse click, touch/swipe, row buttons, and (future) keyboard
 * shortcuts all describe the same user intent as one of these values
 * instead of each calling a different action hook/prop directly.
 *
 * `task.*`/`story.*` commands are implemented by `useWorkItemCommands()`
 * (below), which routes them into the single shared `useTaskActions()` /
 * `useProjectActions()` controllers — see that file for the canonical
 * mutation/optimistic-retention behaviour behind each command.
 *
 * `outline.*` commands describe structural intent (reorder/indent/
 * outdent/fold). `outline.moveUp/moveDown/indent/outdent` are dispatched
 * directly against the specific `useOutlineOrganize()` instance that owns
 * the rendered sibling group — see `docs/architecture-rules.md`'s
 * structural-move invariant; only the interaction scope that registered a
 * given outline knows which mounted `moveBy` handle a keyboard
 * shortcut should reach, and compiled views (Today/Inbox/Waiting/Search)
 * must never expose one. `outline.collapse`/`outline.expand` carry no
 * such risk (folding is pure scope view state, not a mutation), so
 * `useWorkItemCommands()` handles those two generically.
 *
 * `workItem.schedule`, `workItem.setDeadline`, and
 * `workItem.setRevisitDate` are date intents used by Week planning and
 * future date surfaces; they preserve the scheduled-date/deadline/external-wait
 * distinction while still routing through existing task/story action providers.
 * `navigate.*` names the g-prefixed keyboard destinations, and `capture.open`
 * names the contextual QuickAdd entry point.
 */
export type WorkItemCommand =
  | { type: "task.open"; taskId: number; focusField?: TaskDetailFocusField }
  | { type: "task.plan"; taskId: number }
  | { type: "task.reminders"; taskId: number }
  | { type: "task.waitingLifecycle"; taskId: number }
  | { type: "task.split"; taskId: number }
  | { type: "task.assignOwner"; taskId: number }
  | { type: "task.changeProject"; taskId: number }
  | { type: "task.changeParent"; taskId: number }
  | { type: "task.addSuccessor"; taskId: number }
  | { type: "task.recurrence"; taskId: number }
  | { type: "task.priority"; taskId: number }
  | { type: "task.tags"; taskId: number }
  | { type: "task.contexts"; taskId: number }
  | { type: "task.convertToProject"; taskId: number }
  | { type: "task.lifecycle"; taskId: number }
  | { type: "task.setStatus"; task: Task; status: Task["status"] }
  | { type: "task.openOverflow"; taskId: number }
  | { type: "task.toggleDone"; task: Task }
  | { type: "task.toggleAdditionalNextAction"; task: Task }
  | { type: "task.primaryAction"; task: Task }
  | { type: "task.discard"; task: Task }
  | { type: "workItem.schedule"; item: WeekPlanningItem; date: string | null }
  | { type: "workItem.setDeadline"; item: WeekPlanningItem; date: string | null }
  | { type: "workItem.setRevisitDate"; item: WeekPlanningItem; date: string | null }
  | { type: "workItem.open"; workItem: { id: number; role: "story" | "task" } }
  | { type: "story.activate"; story: ProjectWithActions; ownerMemberId?: number | null }
  | { type: "story.returnToBacklog"; story: ProjectWithActions }
  | { type: "story.complete"; story: ProjectWithActions }
  | { type: "story.reopen"; story: ProjectWithActions; ownerMemberId?: number | null }
  | { type: "story.archive"; story: ProjectWithActions }
  | { type: "story.defer"; story: ProjectWithActions }
  | { type: "story.assignDriver"; story: ProjectWithActions }
  | { type: "story.planWork"; story: ProjectWithActions }
  | { type: "story.editOutcome"; story: ProjectWithActions }
  | { type: "story.planDates"; story: ProjectWithActions }
  | { type: "story.tags"; story: ProjectWithActions }
  | { type: "story.contexts"; story: ProjectWithActions }
  | { type: "story.lifecycle"; story: ProjectWithActions }
  | { type: "story.openOverflow"; story: ProjectWithActions }
  | { type: "outline.collapse"; workItemId: number }
  | { type: "outline.expand"; workItemId: number }
  | { type: "outline.moveUp"; workItemId: number }
  | { type: "outline.moveDown"; workItemId: number }
  | { type: "outline.indent"; workItemId: number }
  | { type: "outline.outdent"; workItemId: number }
  | { type: "capture.open" }
  | { type: "navigate.today" }
  | { type: "navigate.inbox" }
  | { type: "navigate.projects" }
  | { type: "navigate.waiting" }
  | { type: "navigate.more" };

/** Canonical semantic commands that may be promoted into a row command rail. */
export type TaskRailCommand =
  | "task.plan"
  | "task.reminders"
  | "task.waitingLifecycle"
  | "task.split"
  | "task.assignOwner"
  | "task.changeProject"
  | "task.addSuccessor"
  | "task.recurrence"
  | "task.priority"
  | "task.tags"
  | "task.contexts"
  | "task.convertToProject"
  | "task.lifecycle";

export type ProjectRailCommand =
  | "story.defer"
  | "story.assignDriver"
  | "story.planWork"
  | "story.editOutcome"
  | "story.planDates"
  | "story.tags"
  | "story.contexts"
  | "story.lifecycle";

/**
 * Maps a legal `ProjectWorkflowAction` onto its `story.*` semantic command
 so every actual workflow transition -- a row's primary swipe/button, its
 * chip strip, the project detail's status group, and any keyboard/palette
 * caller -- goes through the one shared dispatch surface instead of calling
 * `useProjectActions().runAction` directly.
 */
export function storyWorkflowCommand(
  story: ProjectWithActions,
  action: ProjectWorkflowAction,
  ownerMemberId?: number | null,
): WorkItemCommand {
  const ownerMemberIdField =
    ownerMemberId !== undefined ? { ownerMemberId } : {};
  switch (action) {
    case "activate":
      return { type: "story.activate", story, ...ownerMemberIdField };
    case "return_to_backlog":
      return { type: "story.returnToBacklog", story };
    case "complete":
      return { type: "story.complete", story };
    case "reopen":
      return { type: "story.reopen", story, ...ownerMemberIdField };
    case "archive":
    default:
      return { type: "story.archive", story };
  }
}
