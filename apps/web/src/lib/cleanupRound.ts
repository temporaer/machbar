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
 * through `useWorkItemCommands()`, at most seeded with the user's edited
 * answer as an unsaved draft that still needs the destination's own Save.
 */
export type CleanupSurfaceAction =
  | { kind: "markReviewed" }
  | { kind: "command"; command: WorkItemCommand }
  | { kind: "story"; command: CleanupStoryCommand; projectId: number; draft?: string };

export interface CleanupAnswerPrefixes {
  decision: string;
  followup: string;
  doneWhen: string;
}

type SurfaceResult = Pick<CleanupTriageResult, "resolutionSurface" | "suggestedDefault" | "suggestedTitle">;

/** Text-shaped surfaces whose answer is captured on the card and carried along. */
const ANSWER_SURFACES = new Set<CleanupResolutionSurface>([
  "rename_item",
  "edit_done_when",
  "create_decision_task",
  "create_first_slice",
  "create_followup",
  "clarify_admin_target",
]);

export function cleanupAnswerSurface(surface: CleanupResolutionSurface): boolean {
  return ANSWER_SURFACES.has(surface);
}

function prefixed(prefix: string, value: string | null): string {
  return value ? `${prefix}: ${value}` : "";
}

/** The editable answer a card starts with, derived from the AI suggestion. */
export function cleanupDefaultAnswer(
  item: Pick<CleanupRoundItemRecord, "targetType">,
  result: SurfaceResult,
  prefixes: CleanupAnswerPrefixes,
): string {
  const value = result.suggestedDefault ?? result.suggestedTitle;
  switch (result.resolutionSurface) {
    case "rename_item":
      return result.suggestedTitle ?? result.suggestedDefault ?? "";
    case "create_decision_task":
      return prefixed(prefixes.decision, value);
    case "create_followup":
      return prefixed(prefixes.followup, value);
    case "edit_done_when":
      // Project criteria are their own list; task notes need the label.
      return item.targetType === "project" ? value ?? "" : prefixed(prefixes.doneWhen, value);
    case "create_first_slice":
    case "clarify_admin_target":
      return value ?? "";
    default:
      return "";
  }
}

export function cleanupSurfaceAction(
  item: Pick<CleanupRoundItemRecord, "targetType" | "targetId" | "itemStatus">,
  surface: CleanupResolutionSurface,
  answer = "",
): CleanupSurfaceAction {
  if (surface === "mark_reviewed") return { kind: "markReviewed" };
  const id = item.targetId;
  const draft = answer.trim();
  const withDraft = draft ? { draft } : {};
  if (item.targetType === "project") {
    const open = (focusField?: "title" | "notes", text?: string): CleanupSurfaceAction => ({
      kind: "command",
      command: {
        type: "workItem.open",
        workItem: { id, role: "story" },
        ...(focusField ? { focusField } : {}),
        ...(focusField && text ? { draft: text } : {}),
      },
    });
    switch (surface) {
      case "rename_item":
        return open("title", draft);
      case "clarify_admin_target":
        return open("notes", draft);
      case "convert_to_reference":
        return open("notes");
      case "edit_done_when":
        return { kind: "story", command: "story.editOutcome", projectId: id, ...withDraft };
      case "create_decision_task":
      case "create_first_slice":
      case "create_followup":
        return { kind: "story", command: "story.planWork", projectId: id, ...withDraft };
      case "split_clarify_execute":
        return { kind: "story", command: "story.structure", projectId: id };
      case "define_rhythm_or_revisit":
        // Project Wiedervorlage exists only for backlog projects.
        return item.itemStatus === "backlog"
          ? { kind: "story", command: "story.defer", projectId: id }
          : open();
      default:
        return open();
    }
  }
  const command = (value: WorkItemCommand): CleanupSurfaceAction => ({ kind: "command", command: value });
  switch (surface) {
    case "rename_item":
      return command({ type: "task.open", taskId: id, focusField: "title", ...withDraft });
    case "edit_done_when":
    case "clarify_admin_target":
      return command({ type: "task.open", taskId: id, focusField: "notes", ...withDraft });
    case "convert_to_reference":
      return command({ type: "task.open", taskId: id, focusField: "notes" });
    case "create_decision_task":
    case "create_first_slice":
    case "create_followup":
      return command({ type: "task.split", taskId: id, ...(draft ? { initialTitles: [draft] } : {}) });
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

/**
 * A surface that only reaches the plain item view adds nothing over the
 * card's own "Öffnen" button, so it gets no action label of its own.
 */
export function cleanupSurfaceIsPlainOpen(action: CleanupSurfaceAction): boolean {
  return action.kind === "command"
    && action.command.type === "workItem.open"
    && action.command.focusField === undefined;
}

/** Rounds still waiting for Home Assistant are polled. */
export function cleanupRoundPending(status: string): boolean {
  return status === "queued" || status === "analyzing";
}
