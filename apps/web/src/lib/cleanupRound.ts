import type {
  CleanupResolutionSurface,
  CleanupRoundItemRecord,
  CleanupTriageResult,
} from "@machbar/shared";
import type { WorkItemCommand } from "./commands";

/** Story workflows need the full project; the page fetches it before dispatch. */
export type CleanupStoryCommand =
  | "story.editOutcome"
  | "story.planWork"
  | "story.structure"
  | "story.defer";

/**
 * Where a Klärungsrunde resolution surface leads. Results never mutate work
 * items by themselves: apart from `markReviewed` (the canonical review
 * acknowledgement), every surface opens an existing editor or workflow
 * through `useWorkItemCommands()`.
 */
export type CleanupSurfaceAction =
  | { kind: "markReviewed" }
  | { kind: "command"; command: WorkItemCommand }
  | { kind: "story"; command: CleanupStoryCommand; projectId: number };

export interface CleanupChildPrefixes {
  decision: string;
  followup: string;
}

function prefixed(prefix: string, value: string | null): string | null {
  return value ? `${prefix}: ${value}` : null;
}

/** The new child title a surface suggests, if any. */
export function cleanupChildTitle(
  result: Pick<CleanupTriageResult, "resolutionSurface" | "suggestedDefault" | "suggestedTitle">,
  prefixes: CleanupChildPrefixes,
): string | null {
  const value = result.suggestedDefault ?? result.suggestedTitle;
  switch (result.resolutionSurface) {
    case "create_decision_task":
      return prefixed(prefixes.decision, value);
    case "create_followup":
      return prefixed(prefixes.followup, value);
    case "create_first_slice":
      return value;
    default:
      return null;
  }
}

export function cleanupSurfaceAction(
  item: Pick<CleanupRoundItemRecord, "targetType" | "targetId" | "itemStatus">,
  result: Pick<CleanupTriageResult, "resolutionSurface" | "suggestedDefault" | "suggestedTitle">,
  prefixes: CleanupChildPrefixes,
): CleanupSurfaceAction {
  const surface: CleanupResolutionSurface = result.resolutionSurface;
  if (surface === "mark_reviewed") return { kind: "markReviewed" };
  const id = item.targetId;
  if (item.targetType === "project") {
    const open: CleanupSurfaceAction = {
      kind: "command",
      command: { type: "workItem.open", workItem: { id, role: "story" } },
    };
    switch (surface) {
      case "edit_done_when":
        return { kind: "story", command: "story.editOutcome", projectId: id };
      case "create_decision_task":
      case "create_first_slice":
      case "create_followup":
        return { kind: "story", command: "story.planWork", projectId: id };
      case "split_clarify_execute":
        return { kind: "story", command: "story.structure", projectId: id };
      case "define_rhythm_or_revisit":
        // Project Wiedervorlage exists only for backlog projects.
        return item.itemStatus === "backlog"
          ? { kind: "story", command: "story.defer", projectId: id }
          : open;
      default:
        return open;
    }
  }
  const command = (value: WorkItemCommand): CleanupSurfaceAction => ({ kind: "command", command: value });
  switch (surface) {
    case "rename_item":
      return command({ type: "task.open", taskId: id, focusField: "title" });
    case "edit_done_when":
    case "clarify_admin_target":
    case "convert_to_reference":
      return command({ type: "task.open", taskId: id, focusField: "notes" });
    case "create_decision_task":
    case "create_first_slice":
    case "create_followup": {
      const title = cleanupChildTitle(result, prefixes);
      return command({ type: "task.split", taskId: id, ...(title ? { initialTitles: [title] } : {}) });
    }
    case "define_rhythm_or_revisit":
      return command({ type: "task.plan", taskId: id });
    case "choose_shape":
      return command({ type: "task.convertToProject", taskId: id });
    case "split_clarify_execute":
      return command({ type: "task.structure", taskId: id });
    case "open_item":
    default:
      return command({ type: "workItem.open", workItem: { id, role: "task" } });
  }
}

/** Rounds still waiting for Home Assistant are polled. */
export function cleanupRoundPending(status: string): boolean {
  return status === "queued" || status === "analyzing";
}
