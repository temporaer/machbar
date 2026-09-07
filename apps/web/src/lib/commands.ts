import type { Task } from "@machbar/shared";
import type { ProjectWithActions, WeekPlanningItem } from "./api";
import type { TaskDetailFocusField } from "./taskDetailContext";

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
  | { type: "task.toggleDone"; task: Task }
  | { type: "task.primaryAction"; task: Task }
  | { type: "task.discard"; task: Task }
  | { type: "workItem.schedule"; item: WeekPlanningItem; date: string | null }
  | { type: "workItem.setDeadline"; item: WeekPlanningItem; date: string | null }
  | { type: "workItem.setRevisitDate"; item: WeekPlanningItem; date: string | null }
  | { type: "story.activate"; story: ProjectWithActions; ownerMemberId?: number | null }
  | { type: "story.returnToBacklog"; story: ProjectWithActions }
  | { type: "story.complete"; story: ProjectWithActions }
  | { type: "story.reopen"; story: ProjectWithActions; ownerMemberId?: number | null }
  | { type: "story.archive"; story: ProjectWithActions }
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
