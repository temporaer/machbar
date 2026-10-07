import { eq } from "drizzle-orm";
import type { CleanupResolutionSurface } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { addCriterion } from "../domain/storyCapabilities.js";
import { appendProjectNotes, getProjectOrThrow, updateProject } from "../domain/storyCrud.js";
import {
  appendTaskNotes,
  createChildTask,
  createTask,
  getTaskOrThrow,
  updateTask,
} from "../domain/taskCrud.js";
import { assertExpectedRevision, type MutationContext } from "../domain/workItemShared.js";
import { openCleanupRoundItemOrThrow, settleCleanupRoundItem } from "./jobs.js";

/**
 * The confirmable Klärungsrunde micro-flows. Each is one explicit, narrow
 * operation on the card's own target; there is no generic "apply AI result".
 */
export type CleanupRoundAction =
  | { kind: "rename"; title: string; expectedRevision?: number | undefined }
  | { kind: "createTask"; title: string; purpose: "decision" | "firstSlice" | "followup" }
  | { kind: "addDoneWhen"; text: string }
  | {
      kind: "clarifyAdmin";
      title?: string | undefined;
      notes?: string | undefined;
      expectedRevision?: number | undefined;
    };

type Target = { type: "task"; id: number; title: string; revision: number }
  | { type: "project"; id: number; title: string; revision: number };

/**
 * Which stored resolution surfaces each confirmed action may serve. The
 * card's `resolutionSurface` is the source of truth; exploratory surfaces
 * (open, structure, plan, shape, reference) never reach this path.
 */
const ACTION_SURFACES: Record<CleanupRoundAction["kind"], readonly CleanupResolutionSurface[]> = {
  rename: ["rename_item"],
  createTask: ["create_decision_task", "create_first_slice", "create_followup"],
  addDoneWhen: ["edit_done_when"],
  clarifyAdmin: ["clarify_admin_target"],
};

const ACTION_NAMES: Record<CleanupRoundAction["kind"], string> = {
  rename: "rename",
  createTask: "create-task",
  addDoneWhen: "add-done-when",
  clarifyAdmin: "clarify-admin",
};

function storedSurface(resultJson: string | null): string | null {
  if (resultJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(resultJson);
    const surface = (parsed as { resolutionSurface?: unknown } | null)?.resolutionSurface;
    return typeof surface === "string" ? surface : null;
  } catch {
    return null;
  }
}

function assertActionMatchesSurface(kind: CleanupRoundAction["kind"], resultJson: string | null): void {
  const surface = storedSurface(resultJson);
  if (surface === null) {
    throw AppError.conflict(
      "cleanup_round_state_conflict",
      "This item has no usable suggestion.",
      { action: ACTION_NAMES[kind] },
    );
  }
  if (!(ACTION_SURFACES[kind] as readonly string[]).includes(surface)) {
    throw AppError.conflict(
      "cleanup_round_action_surface_mismatch",
      "This action does not fit the Klärungsrunde suggestion.",
      { action: ACTION_NAMES[kind], resolutionSurface: surface },
    );
  }
}

function noChange(): AppError {
  return AppError.badRequest("cleanup_round_action_no_change", "The confirmed action does not change anything.");
}

function targetOrThrow(db: Db, targetType: "task" | "project", targetId: number): Target {
  const row = db.select({ role: schema.workItems.role })
    .from(schema.workItems).where(eq(schema.workItems.id, targetId)).get();
  if (row && row.role !== (targetType === "project" ? "story" : "task")) {
    throw AppError.conflict(
      "cleanup_round_target_mismatch",
      "The Klärungsrunde item no longer matches its target.",
      { targetType, targetId },
    );
  }
  if (targetType === "project") {
    const project = getProjectOrThrow(db, targetId);
    return { type: "project", id: project.id, title: project.title, revision: project.revision };
  }
  const task = getTaskOrThrow(db, targetId);
  return { type: "task", id: task.id, title: task.title, revision: task.revision };
}

function rename(db: Db, target: Target, title: string, context: MutationContext): void {
  if (target.type === "project") updateProject(db, target.id, { title }, context);
  else updateTask(db, target.id, { title }, context);
}

function appendNotes(db: Db, target: Target, content: string, context: MutationContext): void {
  if (target.type === "project") appendProjectNotes(db, target.id, content, context);
  else appendTaskNotes(db, target.id, content, context);
}

/**
 * Applies one confirmed micro-flow through the canonical domain functions and
 * dismisses the card in the same transaction: either the item is improved and
 * the card is gone, or nothing changes. Never touches `reviewedAt`.
 */
export function applyCleanupRoundAction(
  db: Db,
  input: {
    roundId: string;
    itemId: string;
    viewerMemberId: number | null;
    actorMemberId: number | null;
    action: CleanupRoundAction;
  },
): void {
  const context: MutationContext = { actorMemberId: input.actorMemberId };
  const { action } = input;
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const { round, item } = openCleanupRoundItemOrThrow(txDb, input.roundId, input.itemId, input.viewerMemberId);
    if (item.status !== "ready") {
      throw AppError.conflict("cleanup_round_state_conflict", "This item has no confirmed suggestion.");
    }
    assertActionMatchesSurface(action.kind, item.resultJson);
    const target = targetOrThrow(txDb, item.targetType, item.targetId);
    switch (action.kind) {
      case "rename": {
        assertExpectedRevision(target.type, target.id, target.revision, action.expectedRevision);
        const title = action.title.trim();
        if (title === target.title) throw noChange();
        rename(txDb, target, title, context);
        break;
      }
      case "createTask": {
        const task = { title: action.title.trim(), status: "actionable" as const, createdByMemberId: input.viewerMemberId };
        // Owner, context, and tags inherit from the parent task or project as usual.
        if (target.type === "project") createTask(txDb, { ...task, projectId: target.id, parentTaskId: null }, context);
        else createChildTask(txDb, target.id, task, context);
        break;
      }
      case "addDoneWhen": {
        const text = action.text.trim();
        if (target.type === "project") addCriterion(txDb, target.id, text, context);
        else appendNotes(txDb, target, text, context);
        break;
      }
      case "clarifyAdmin": {
        assertExpectedRevision(target.type, target.id, target.revision, action.expectedRevision);
        const title = action.title?.trim() ?? "";
        const notes = action.notes?.trim() ?? "";
        const titleChanged = title !== "" && title !== target.title;
        if (!titleChanged && notes === "") throw noChange();
        if (titleChanged) rename(txDb, target, title, context);
        if (notes !== "") appendNotes(txDb, target, notes, context);
        break;
      }
    }
    settleCleanupRoundItem(txDb, round, item, "dismissed");
  });
}
