import type { Project, ProjectStatus } from "@machbar/shared";
import type { ProjectWorkflowAction } from "./api";
import type { Strings } from "./strings";

/**
 * Frontend mirror of `apps/api/src/domain/mutations.ts::workflowActionsByStatus`.
 *
 * The backend remains the single source of truth — every project response
 * carries its own `availableActions`, and that list is what the UI renders.
 * This table is only used to (a) predict the `availableActions` of an
 * *optimistic* row that has not been refetched yet (so a just-transitioned
 * story can immediately be swiped on again, e.g. `abschließen → wieder
 * öffnen`), and (b) fall back for callers that hand us a bare `Project`
 * without the API's convenience field.
 */
export const workflowActionsByStatus: Record<ProjectStatus, ProjectWorkflowAction[]> = {
  backlog: ["activate", "archive"],
  active: ["return_to_backlog", "complete", "archive"],
  completed: ["reopen", "archive"],
  archived: ["activate", "return_to_backlog"],
};

/** Status a story ends up in after a given transition (mirrors the backend). */
export const statusAfterAction: Record<ProjectWorkflowAction, ProjectStatus> = {
  activate: "active",
  return_to_backlog: "backlog",
  complete: "completed",
  reopen: "active",
  archive: "archived",
};

/** Imperative button/chip labels for the selected locale. */
export function projectWorkflowLabel(
  action: ProjectWorkflowAction,
  strings: Strings,
): string {
  return {
    activate: strings.activateStory,
    return_to_backlog: strings.returnToBacklogStory,
    complete: strings.completeStory,
    reopen: strings.reopen,
    archive: strings.archiveStory,
  }[action];
}

/**
 * Past-tense confirmations shown in a row's status badge while the row is
 * retained, i.e. right after the transition ("Aktiviert", "Abgeschlossen", …).
 */
export function projectTransitionLabel(
  action: ProjectWorkflowAction,
  strings: Strings,
): string {
  return {
    activate: strings.storyActivated,
    return_to_backlog: strings.storyReturnedToBacklog,
    complete: strings.storyCompleted,
    reopen: strings.storyReopened,
    archive: strings.storyArchived,
  }[action];
}

/** Glyph for the dedicated (non-gesture) primary control of each transition. */
export const projectWorkflowIcons: Record<ProjectWorkflowAction, string> = {
  activate: "▶",
  return_to_backlog: "↩",
  complete: "✓",
  reopen: "↺",
  archive: "⌸",
};

/**
 * The workflow step a right swipe (and the row's dedicated primary button)
 * performs, per status: the one obvious "move this story forward" action.
 *
 * - `backlog` → activate (start work; asks for a driver first if missing)
 * - `active` → complete
 * - `completed` → reopen
 * - `archived` → activate (bring it back into play; driver rule applies again)
 */
const preferredPrimaryByStatus: Record<ProjectStatus, ProjectWorkflowAction> = {
  backlog: "activate",
  active: "complete",
  completed: "reopen",
  archived: "activate",
};

function legalActions(story: Project & { availableActions?: ProjectWorkflowAction[] }): ProjectWorkflowAction[] {
  return story.availableActions ?? workflowActionsByStatus[story.status];
}

/**
 * Primary transition for a story, always validated against the actions the
 * backend actually advertises, so the UI can never offer an illegal step.
 */
export function primaryWorkflowAction(
  story: Project & { availableActions?: ProjectWorkflowAction[] },
): ProjectWorkflowAction | null {
  const actions = legalActions(story);
  const preferred = preferredPrimaryByStatus[story.status];
  if (actions.includes(preferred)) return preferred;
  return actions[0] ?? null;
}

/**
 * Every *other* legal transition, offered as chips in the left-swipe/kebab
 * strip (e.g. "In Backlog zurücklegen" and "Archivieren" for an active story).
 */
export function secondaryWorkflowActions(
  story: Project & { availableActions?: ProjectWorkflowAction[] },
): ProjectWorkflowAction[] {
  const primary = primaryWorkflowAction(story);
  return legalActions(story).filter((action) => action !== primary);
}

/**
 * Activating a story requires a driver (backend invariant). When the story
 * has none yet, the UI must collect one first and activate atomically in the
 * same call instead of letting the request fail.
 */
export function needsDriverBeforeAction(story: Project, action: ProjectWorkflowAction): boolean {
  return action === "activate" && story.ownerMemberId === null;
}

/**
 * A story's driver may only be cleared while it sits in the backlog — see
 * `updateProject` in `apps/api/src/domain/mutations.ts`. Everything else
 * (active/completed/archived) can be reassigned but never unassigned.
 */
export function canClearDriver(story: Project): boolean {
  return story.status === "backlog";
}
