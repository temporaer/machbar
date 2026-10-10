import { inArray } from "drizzle-orm";
import type { IntakeApplyResults, IntakeDraft, Task } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import { createChildTask, createTask, updateTask } from "../domain/taskCrud.js";
import { convertTaskToStory } from "../domain/roleConversion.js";
import type { MutationContext } from "../domain/workItemShared.js";
import { getDescendantIds } from "../repo/treeRepo.js";

export const BREAKDOWN_ROOT_KEY = "existing-task";

/** Stable persisted state, including children added, removed, or moved meanwhile. */
export function breakdownSnapshot(db: Db, taskId: number): string {
  const ids = [taskId, ...getDescendantIds(db, taskId)];
  return JSON.stringify(db.select().from(schema.workItems)
    .where(inArray(schema.workItems.id, ids)).orderBy(schema.workItems.id).all());
}

export function breakdownTask(db: Db, taskId: number, viewerMemberId: number | null) {
  const task = Graph.load(db, undefined, viewerMemberId ?? undefined).tasksById.get(taskId);
  if (!task) throw AppError.notFound("task_not_found", "The requested task was not found.");
  if (task.kind !== "action" || task.status === "done" || task.status === "cancelled") {
    throw AppError.conflict("task_promotion_invalid", "Only open action tasks can be broken down.");
  }
  return task;
}

export function breakdownSourceText(task: ReturnType<typeof breakdownTask>): string {
  const describe = (item: Task): unknown => ({
    id: item.id, title: item.title, notes: item.notes, status: item.status,
    children: item.children.map((child) => describe(child)),
  });
  return JSON.stringify({
    task: describe(task), parentTaskId: task.parentTaskId, projectId: task.projectId,
    externalWait: task.externalWait, dependencies: task.dependencies,
    repeatAfterDays: task.repeatAfterDays, reminders: task.reminders,
  });
}

/** Breakdown edits one existing root and appends a flat list of new actions. */
export function assertBreakdownDraft(draft: IntakeDraft): void {
  const enabled = draft.workItems.filter((item) => item.enabled);
  const root = enabled.find((item) => item.key === BREAKDOWN_ROOT_KEY);
  if (!root || root.parentKey !== null || !["action", "project"].includes(root.kind)
    || enabled.length < 2 || enabled.length > 31
    || enabled.some((item) => item !== root && (item.kind !== "action" || item.parentKey !== root.key))
    || enabled.some((item) => item.needsClarification)
    || draft.calendarEvents.some((item) => item.enabled) || draft.retainSourceInPaperless) {
    throw AppError.badRequest("intake_draft_invalid", "Keep the existing root and 1–30 immediate action steps; calendar events, references, and nested projects are not supported in a breakdown.");
  }
  // The existing item's metadata is preserved. Expose only its title, notes,
  // and role in review rather than silently accepting edits to ignored fields.
  if (root.ownerMemberId !== null || root.dueDate !== null || root.scheduledDate !== null
    || root.revisitAt != null || root.notBeforeAt !== null || root.notBeforeDate !== null
    || root.reminders.length > 0 || root.relatedCalendarKeys.length > 0) {
    throw AppError.badRequest("intake_draft_invalid", "The existing root supports title, notes, and project conversion only; its other metadata is preserved.");
  }
}

/** Called inside the intake Apply transaction; never a separate mutation path. */
export function applyBreakdown(
  db: Db,
  job: typeof schema.intakeJobs.$inferSelect,
  draft: IntakeDraft,
  context: MutationContext,
  viewerMemberId: number | null,
): IntakeApplyResults {
  assertBreakdownDraft(draft);
  const task = breakdownTask(db, job.breakdownTaskId!, viewerMemberId);
  if (breakdownSnapshot(db, task.id) !== job.breakdownSnapshotJson) {
    throw AppError.conflict("stale_write_conflict", "The task or its steps changed. Start a new breakdown and review the updated proposal.");
  }
  const root = draft.workItems.find((item) => item.key === BREAKDOWN_ROOT_KEY)!;
  const converted = root.kind === "project";
  if (converted) {
    convertTaskToStory(db, task.id, {
      status: "backlog", title: root.title, notes: root.notes ?? "",
      expectedRevision: task.revision,
    }, context);
  } else if (root.title !== task.title || (root.notes ?? "") !== task.notes) {
    updateTask(db, task.id, {
      title: root.title, notes: root.notes ?? "", expectedRevision: task.revision,
    }, context);
  }
  const results: IntakeApplyResults = { work: [{
    key: root.key, kind: root.kind, workItemId: task.id, role: converted ? "story" : "task",
  }], calendar: [], paperlessDocumentIds: [] };
  for (const item of draft.workItems.filter((item) => item.enabled && item.key !== root.key)) {
    const input = {
      title: item.title, notes: item.notes ?? "", status: "actionable" as const,
      ...(item.ownerMemberId === null ? {} : { ownerMemberId: item.ownerMemberId, ownerInheritanceMode: "explicit" as const }),
      dueDate: item.dueDate, scheduledDate: item.scheduledDate,
      revisitAt: item.revisitAt ?? item.notBeforeAt,
      reminders: item.reminders.length ? item.reminders : undefined,
      createdByMemberId: job.createdByMemberId,
    };
    const child = converted
      ? createTask(db, { ...input, projectId: task.id }, context)
      : createChildTask(db, task.id, input, context);
    results.work.push({ key: item.key, kind: "action", workItemId: child.id, role: "task" });
  }
  return results;
}
