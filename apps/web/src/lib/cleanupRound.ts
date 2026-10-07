import type {
  CleanupResolutionSurface,
  CleanupRoundItemRecord,
  CleanupTriageResult,
} from "@machbar/shared";
import type { WorkItemCommand } from "./commands";

/** Story workflows need the full project; the page fetches it before dispatch. */
export type CleanupStoryCommand = "story.structure" | "story.defer";

/**
 * One explicit, confirmable improvement. Each kind maps to exactly one
 * canonical mutation (or, for `clarifyAdmin`, a rename and/or a notes
 * append); there is no generic "apply AI result" operation.
 */
export type CleanupMicroFlow =
  | { kind: "rename"; title: string }
  | { kind: "createTask"; purpose: "decision" | "firstSlice" | "followup"; title: string }
  | { kind: "addCriterion"; text: string }
  | { kind: "appendNotes"; text: string }
  | { kind: "clarifyAdmin"; title: string; notes: string };

/**
 * Where a Klärungsrunde resolution surface leads. Results never mutate work
 * items by themselves: `markReviewed` is the canonical review
 * acknowledgement, `confirm` opens a focused confirmation sheet that shows
 * exactly what will change before the user commits it, and `command`/`story`
 * open an existing workflow where Machbar has no specific action to offer.
 */
export type CleanupSurfaceAction =
  | { kind: "markReviewed" }
  | { kind: "confirm"; flow: CleanupMicroFlow; label: CleanupActionLabel }
  | { kind: "command"; command: WorkItemCommand; label: CleanupActionLabel | null }
  | { kind: "story"; command: CleanupStoryCommand; projectId: number; label: CleanupActionLabel };

/**
 * What the card's primary button says. Labels describe what actually
 * happens: micro-flow labels name the change the confirmation sheet will
 * make, "Öffnen und …" labels open an item where the user still decides.
 * `null` means the surface only reaches the plain item view, which the
 * card's own "Öffnen" button already covers.
 */
export type CleanupActionLabel =
  | "rename"
  | "doneWhenNotes"
  | "doneWhenCriterion"
  | "createProjectTask"
  | "createChildTask"
  | "planTask"
  | "deferProject"
  | "admin"
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
      return value ?? "";
    case "clarify_admin_target":
      // The concrete wording lives in suggestedTitle; the answer carries details.
      return result.suggestedDefault ?? "";
    default:
      return "";
  }
}

export function cleanupSurfaceAction(
  item: Pick<CleanupRoundItemRecord, "targetType" | "targetId" | "itemStatus" | "title">,
  result: Pick<CleanupTriageResult, "resolutionSurface" | "suggestedShape" | "suggestedTitle">,
  answer = "",
): CleanupSurfaceAction {
  const surface = result.resolutionSurface;
  if (surface === "mark_reviewed") return { kind: "markReviewed" };
  const id = item.targetId;
  const text = answer.trim();
  const confirm = (flow: CleanupMicroFlow, label: CleanupActionLabel): CleanupSurfaceAction => ({
    kind: "confirm",
    flow,
    label,
  });
  const command = (value: WorkItemCommand, label: CleanupActionLabel | null): CleanupSurfaceAction => ({
    kind: "command",
    command: value,
    label,
  });
  const createLabel: CleanupActionLabel = item.targetType === "project" ? "createProjectTask" : "createChildTask";
  switch (surface) {
    case "rename_item":
      return confirm({ kind: "rename", title: text }, "rename");
    case "edit_done_when":
      return item.targetType === "project"
        ? confirm({ kind: "addCriterion", text }, "doneWhenCriterion")
        : confirm({ kind: "appendNotes", text }, "doneWhenNotes");
    case "create_decision_task":
      return confirm({ kind: "createTask", purpose: "decision", title: text }, createLabel);
    case "create_first_slice":
      return confirm({ kind: "createTask", purpose: "firstSlice", title: text }, createLabel);
    case "create_followup":
      return confirm({ kind: "createTask", purpose: "followup", title: text }, createLabel);
    case "clarify_admin_target":
      return confirm(
        { kind: "clarifyAdmin", title: result.suggestedTitle?.trim() || item.title, notes: text },
        "admin",
      );
    default:
      break;
  }
  if (item.targetType === "project") {
    const open: WorkItemCommand = { type: "workItem.open", workItem: { id, role: "story" } };
    const story = (value: CleanupStoryCommand, label: CleanupActionLabel): CleanupSurfaceAction => ({
      kind: "story",
      command: value,
      projectId: id,
      label,
    });
    switch (surface) {
      case "split_clarify_execute":
        return story("story.structure", "structure");
      case "define_rhythm_or_revisit":
        // Project Wiedervorlage exists only for backlog projects.
        return item.itemStatus === "backlog" ? story("story.defer", "deferProject") : command(open, null);
      case "convert_to_reference":
        // Projects have no reference shape; the user can only check it.
        return command(open, "checkReference");
      case "choose_shape":
        return result.suggestedShape === "reference" ? command(open, "checkReference") : command(open, null);
      default:
        return command(open, null);
    }
  }
  switch (surface) {
    case "convert_to_reference":
      // There is no canonical action → reference conversion; only a check.
      return command({ type: "task.open", taskId: id, focusField: "notes" }, "checkReference");
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
