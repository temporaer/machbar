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
  | { kind: "command"; command: WorkItemCommand; label: CleanupActionLabel | null }
  | { kind: "story"; command: CleanupStoryCommand; projectId: number; label: CleanupActionLabel; draft?: string };

/**
 * What the card's primary button says. Labels describe what the destination
 * actually does: "… anlegen/übernehmen …" only where the answer is carried
 * into that workflow, "Öffnen und …" where the user still decides there.
 * `null` means the surface only reaches the plain item view, which the card's
 * own "Öffnen" button already covers.
 */
export type CleanupActionLabel =
  | "rename"
  | "doneWhenNotes"
  | "doneWhenCriterion"
  | "decision"
  | "firstSlice"
  | "followup"
  | "planTask"
  | "deferProject"
  | "adminNotes"
  | "convertToProject"
  | "checkReference"
  | "structure";

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
  result: Pick<CleanupTriageResult, "resolutionSurface" | "suggestedShape">,
  answer = "",
): CleanupSurfaceAction {
  const surface = result.resolutionSurface;
  if (surface === "mark_reviewed") return { kind: "markReviewed" };
  const id = item.targetId;
  const draft = answer.trim();
  const withDraft = draft ? { draft } : {};
  const command = (value: WorkItemCommand, label: CleanupActionLabel | null): CleanupSurfaceAction => ({
    kind: "command",
    command: value,
    label,
  });
  if (item.targetType === "project") {
    const open = (focusField?: "title" | "notes", text?: string): WorkItemCommand => ({
      type: "workItem.open",
      workItem: { id, role: "story" },
      ...(focusField ? { focusField } : {}),
      ...(focusField && text ? { draft: text } : {}),
    });
    const story = (value: CleanupStoryCommand, label: CleanupActionLabel, text?: string): CleanupSurfaceAction => ({
      kind: "story",
      command: value,
      projectId: id,
      label,
      ...(text ? { draft: text } : {}),
    });
    switch (surface) {
      case "rename_item":
        return command(open("title", draft), "rename");
      case "clarify_admin_target":
        return command(open("notes", draft), "adminNotes");
      case "convert_to_reference":
        return command(open("notes"), "checkReference");
      case "edit_done_when":
        return story("story.editOutcome", "doneWhenCriterion", draft);
      case "create_decision_task":
        return story("story.planWork", "decision", draft);
      case "create_first_slice":
        return story("story.planWork", "firstSlice", draft);
      case "create_followup":
        return story("story.planWork", "followup", draft);
      case "split_clarify_execute":
        return story("story.structure", "structure");
      case "define_rhythm_or_revisit":
        // Project Wiedervorlage exists only for backlog projects.
        return item.itemStatus === "backlog" ? story("story.defer", "deferProject") : command(open(), null);
      case "choose_shape":
        // There is no project → task/reference conversion; only a check.
        return result.suggestedShape === "reference"
          ? command(open("notes"), "checkReference")
          : command(open(), null);
      default:
        return command(open(), null);
    }
  }
  switch (surface) {
    case "rename_item":
      return command({ type: "task.open", taskId: id, focusField: "title", ...withDraft }, "rename");
    case "edit_done_when":
      return command({ type: "task.open", taskId: id, focusField: "notes", ...withDraft }, "doneWhenNotes");
    case "clarify_admin_target":
      return command({ type: "task.open", taskId: id, focusField: "notes", ...withDraft }, "adminNotes");
    case "convert_to_reference":
      return command({ type: "task.open", taskId: id, focusField: "notes" }, "checkReference");
    case "create_decision_task":
    case "create_first_slice":
    case "create_followup":
      return command(
        { type: "task.split", taskId: id, ...(draft ? { initialTitles: [draft] } : {}) },
        surface === "create_decision_task" ? "decision" : surface === "create_followup" ? "followup" : "firstSlice",
      );
    case "define_rhythm_or_revisit":
      return command({ type: "task.plan", taskId: id }, "planTask");
    case "choose_shape":
      // Only task → project is a real conversion; other shapes stay a check.
      if (result.suggestedShape === "reference") {
        return command({ type: "task.open", taskId: id, focusField: "notes" }, "checkReference");
      }
      return result.suggestedShape === "task"
        ? command({ type: "workItem.open", workItem: { id, role: "task" } }, null)
        : command({ type: "task.convertToProject", taskId: id }, "convertToProject");
    case "split_clarify_execute":
      return command({ type: "task.structure", taskId: id }, "structure");
    case "open_item":
    default:
      return command({ type: "workItem.open", workItem: { id, role: "task" } }, null);
  }
}

/** Rounds still waiting for Home Assistant are polled. */
export function cleanupRoundPending(status: string): boolean {
  return status === "queued" || status === "analyzing";
}
