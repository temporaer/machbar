/** Ordered, structured completion criteria shared by projects and tasks. */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  neutralizeContribution,
  recordActivity,
  recordContribution,
} from "../repo/index.js";
import {
  MutationContext,
  actor,
  nowIso,
  touchProject,
  touchTask,
} from "./workItemShared.js";

// ---------------------------------------------------------------------------
// Acceptance criteria (ordered, structured; replaces free-text description)
// ---------------------------------------------------------------------------

type CriterionOwner = { id: number; title: string; role: "story" | "task"; taskKind: string | null };

function getCriterionOwnerOrThrow(db: Db, workItemId: number): CriterionOwner {
  const owner = db.select({
    id: schema.workItems.id,
    title: schema.workItems.title,
    role: schema.workItems.role,
    taskKind: schema.workItems.taskKind,
  }).from(schema.workItems).where(eq(schema.workItems.id, workItemId)).get();
  if (!owner || (owner.role === "task" && owner.taskKind !== "action")) {
    throw AppError.notFound("acceptance_criterion_not_found", "Completion criteria require a project or action task.", { workItemId });
  }
  return owner as CriterionOwner;
}

function touchCriterionOwner(db: Db, owner: CriterionOwner) {
  if (owner.role === "story") touchProject(db, owner.id);
  else touchTask(db, owner.id);
}

function recordCriterionActivity(
  db: Db,
  owner: CriterionOwner,
  verb: "added" | "updated" | "checked" | "removed",
  context?: MutationContext,
  metadata?: Record<string, unknown>,
) {
  const entityType = owner.role === "story" ? "project" : "task";
  const kind = entityType === "project"
    ? `project_acceptance_criterion_${verb}` as const
    : `task_acceptance_criterion_${verb}` as const;
  return recordActivity(db, {
    actorMemberId: actor(context),
    kind,
    entityType,
    entityTitle: owner.title,
    ...(entityType === "project" ? { projectId: owner.id } : { taskId: owner.id }),
    metadata,
  });
}

function getCriterionOrThrow(db: Db, workItemId: number, criterionId: number) {
  const criterion = db
    .select()
    .from(schema.workItemAcceptanceCriteria)
    .where(eq(schema.workItemAcceptanceCriteria.id, criterionId))
    .get();
  if (!criterion || criterion.workItemId !== workItemId) {
    throw AppError.notFound(
      "acceptance_criterion_not_found",
      "The requested completion criterion was not found in this work item.",
      { workItemId, criterionId },
    );
  }
  return criterion;
}

function normalizeCriterionText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw AppError.badRequest(
      "acceptance_criterion_text_required",
      "The acceptance criterion text must not be empty.",
    );
  }
  return trimmed;
}

export function assertAcceptanceCriteriaChecked(
  db: Db,
  workItemId: number,
  ownerType: "project" | "task" = "task",
): void {
  const criteria = db.select({ id: schema.workItemAcceptanceCriteria.id, checked: schema.workItemAcceptanceCriteria.checked })
    .from(schema.workItemAcceptanceCriteria)
    .where(eq(schema.workItemAcceptanceCriteria.workItemId, workItemId))
    .all();
  const incompleteIds = criteria.filter((criterion) => !criterion.checked).map((criterion) => criterion.id);
  if (incompleteIds.length > 0) {
    throw AppError.conflict(
      ownerType === "task" ? "task_completion_criteria_incomplete" : "project_completion_criteria_incomplete",
      `Every completion criterion must be checked before completing this ${ownerType}.`,
      { [ownerType === "task" ? "taskId" : "projectId"]: workItemId, criteriaCount: criteria.length, incompleteCriterionIds: incompleteIds },
    );
  }
}

/**
 * Applies the criteria a person checked as part of the same completion
 * transaction. Validation happens before any row changes; the owner revision
 * is advanced by the enclosing completion transition, not once per checkbox.
 */
export function checkCriteriaForCompletion(
  db: Db,
  workItemId: number,
  selectedCriterionIds: readonly number[] = [],
  context?: MutationContext,
): void {
  const owner = getCriterionOwnerOrThrow(db, workItemId);
  const criteria = db.select().from(schema.workItemAcceptanceCriteria)
    .where(eq(schema.workItemAcceptanceCriteria.workItemId, workItemId)).all();
  const selected = new Set(selectedCriterionIds);
  const unknown = selectedCriterionIds.filter((id) => !criteria.some((criterion) => criterion.id === id));
  if (unknown.length > 0) {
    throw AppError.badRequest("completion_criteria_invalid", "A selected completion criterion does not belong to this work item.", { workItemId, criterionIds: unknown });
  }
  const missing = criteria.filter((criterion) => !criterion.checked && !selected.has(criterion.id)).map((criterion) => criterion.id);
  if (missing.length > 0) {
    throw AppError.conflict(
      owner.role === "story" ? "project_completion_criteria_incomplete" : "task_completion_criteria_incomplete",
      `Every completion criterion must be checked before completing this ${owner.role === "story" ? "project" : "task"}.`,
      { [owner.role === "story" ? "projectId" : "taskId"]: workItemId, criteriaCount: criteria.length, incompleteCriterionIds: missing },
    );
  }
  for (const criterion of criteria) {
    if (criterion.checked || !selected.has(criterion.id)) continue;
    db.update(schema.workItemAcceptanceCriteria)
      .set({ checked: true, updatedAt: nowIso() })
      .where(eq(schema.workItemAcceptanceCriteria.id, criterion.id)).run();
    recordCriterionActivity(db, owner, "checked", context, { checked: true, duringCompletion: true });
  }
}

/** Appends a new criterion at the end of the work item's ordered list. */
export function addCriterion(
  db: Db,
  workItemId: number,
  text: string,
  context?: MutationContext,
) {
  const trimmed = normalizeCriterionText(text);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const owner = getCriterionOwnerOrThrow(txDb, workItemId);
    const maxPosition = tx
      .select({ position: schema.workItemAcceptanceCriteria.position })
      .from(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.workItemId, workItemId))
      .all()
      .reduce((max, c) => Math.max(max, c.position), -1);
    const criterion = tx
      .insert(schema.workItemAcceptanceCriteria)
      .values({ workItemId, text: trimmed, position: maxPosition + 1 })
      .returning()
      .get();
    touchCriterionOwner(txDb, owner);
    const activityEventId = recordCriterionActivity(txDb, owner, "added", context);
    if (maxPosition === -1 && owner.role === "story") {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "project_outcome_added",
        entityType: "project",
        entityId: workItemId,
        personalEligible: true,
      });
    }
    return criterion;
  });
}

/** Edits a criterion's text without changing its position/checked state. */
export function updateCriterionText(
  db: Db,
  workItemId: number,
  criterionId: number,
  text: string,
  context?: MutationContext,
) {
  const trimmed = normalizeCriterionText(text);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const owner = getCriterionOwnerOrThrow(txDb, workItemId);
    const criterion = getCriterionOrThrow(txDb, workItemId, criterionId);
    if (criterion.text === trimmed) return criterion;
    tx.update(schema.workItemAcceptanceCriteria)
      .set({ text: trimmed, updatedAt: nowIso() })
      .where(eq(schema.workItemAcceptanceCriteria.id, criterionId))
      .run();
    const updated = tx
      .select()
      .from(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.id, criterionId))
      .get()!;
    touchCriterionOwner(txDb, owner);
    recordCriterionActivity(txDb, owner, "updated", context);
    return updated;
  });
}

/** Checks/unchecks a single criterion (completion itself stays manual). */
export function setCriterionChecked(
  db: Db,
  workItemId: number,
  criterionId: number,
  checked: boolean,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const owner = getCriterionOwnerOrThrow(txDb, workItemId);
    const criterion = getCriterionOrThrow(txDb, workItemId, criterionId);
    if (criterion.checked === checked) return criterion;
    tx.update(schema.workItemAcceptanceCriteria)
      .set({ checked, updatedAt: nowIso() })
      .where(eq(schema.workItemAcceptanceCriteria.id, criterionId))
      .run();
    const updated = tx
      .select()
      .from(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.id, criterionId))
      .get()!;
    touchCriterionOwner(txDb, owner);
    recordCriterionActivity(txDb, owner, "checked", context, { checked });
    return updated;
  });
}

/**
 * Reorders a project's criteria: `orderedCriterionIds` must be exactly the
 * project's existing criterion ids, each listed once, in the desired
 * order — anything else (missing/extra/duplicate/foreign ids) is rejected
 * so positions can never end up sparse or ambiguous.
 */
export function reorderCriteria(
  db: Db,
  workItemId: number,
  orderedCriterionIds: number[],
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const owner = getCriterionOwnerOrThrow(txDb, workItemId);
    const existing = tx
      .select()
      .from(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.workItemId, workItemId))
      .all();
    const existingIds = new Set(existing.map((c) => c.id));
    const uniqueRequestedIds = new Set(orderedCriterionIds);
    const isValidReordering =
      orderedCriterionIds.length === existing.length &&
      uniqueRequestedIds.size === orderedCriterionIds.length &&
      orderedCriterionIds.every((id) => existingIds.has(id));
    if (!isValidReordering) {
      throw AppError.badRequest(
        "acceptance_criteria_order_invalid",
        "The criterion order must contain every existing criterion exactly once.",
        {
          workItemId,
          requestedCriterionIds: orderedCriterionIds,
          existingCriterionIds: existing.map((criterion) => criterion.id),
        },
      );
    }
    orderedCriterionIds.forEach((criterionId, index) => {
      tx.update(schema.workItemAcceptanceCriteria)
        .set({ position: index, updatedAt: nowIso() })
        .where(eq(schema.workItemAcceptanceCriteria.id, criterionId))
        .run();
    });
    touchCriterionOwner(txDb, owner);
    return tx
      .select()
      .from(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.workItemId, workItemId))
      .all()
      .sort((a, b) => a.position - b.position);
  });
}

/** Removes a criterion and compacts the remaining positions (no gaps). */
export function removeCriterion(
  db: Db,
  workItemId: number,
  criterionId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const owner = getCriterionOwnerOrThrow(txDb, workItemId);
    getCriterionOrThrow(txDb, workItemId, criterionId);
    tx.delete(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.id, criterionId))
      .run();
    const remaining = tx
      .select()
      .from(schema.workItemAcceptanceCriteria)
      .where(eq(schema.workItemAcceptanceCriteria.workItemId, workItemId))
      .all()
      .sort((a, b) => a.position - b.position);
    remaining.forEach((criterion, index) => {
      if (criterion.position !== index) {
        tx.update(schema.workItemAcceptanceCriteria)
          .set({ position: index, updatedAt: nowIso() })
          .where(eq(schema.workItemAcceptanceCriteria.id, criterion.id))
          .run();
      }
    });
    touchCriterionOwner(txDb, owner);
    const activityEventId = recordCriterionActivity(txDb, owner, "removed", context);
    if (remaining.length === 0 && owner.role === "story") {
      neutralizeContribution(txDb, {
        activityEventId,
        reason: "project_outcome_added",
        entityType: "project",
        entityId: workItemId,
      });
    }
  });
}
