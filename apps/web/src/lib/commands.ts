import type { Task } from "@machbar/shared";
import type { ProjectWithActions } from "./api";
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
 * given outline (Phase 4) knows which mounted `moveBy` handle a keyboard
 * shortcut should reach, and compiled views (Today/Inbox/Waiting/Search)
 * must never expose one. `outline.collapse`/`outline.expand` carry no
 * such risk (folding is pure scope view state, not a mutation), so
 * `useWorkItemCommands()` handles those two generically.
 *
 * `navigate.*` names the g-prefixed keyboard destinations; `capture.open`
 * names the contextual quick-add entry point. Both are listed here now so
 * the vocabulary is complete, and are wired up by the interaction scope /
 * keyboard layer (Phase 4/5) once a capture-target/route registry exists.
 */
export type WorkItemCommand =
  | { type: "task.open"; taskId: number; focusField?: TaskDetailFocusField }
  | { type: "task.toggleDone"; task: Task }
  | { type: "task.primaryAction"; task: Task }
  | { type: "task.discard"; task: Task }
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

