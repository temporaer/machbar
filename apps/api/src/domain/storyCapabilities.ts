/**
 * Ordered, structured acceptance criteria ("Erledigt, wenn ...") attached to a
 * story, replacing free-text completion criteria.
 */
import { and, eq, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  neutralizeContribution,
  recordActivity,
  recordContribution,
} from "../repo/index.js";
import { getProjectOrThrow } from "./storyCrud.js";
import {
  MutationContext,
  actor,
  nowIso,
  touchProject,
} from "./workItemShared.js";

// ---------------------------------------------------------------------------
// Acceptance criteria (ordered, structured; replaces free-text description)
// ---------------------------------------------------------------------------

function getCriterionOrThrow(db: Db, projectId: number, criterionId: number) {
  const criterion = db
    .select()
    .from(schema.projectAcceptanceCriteria)
    .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
    .get();
  if (!criterion || criterion.projectId !== projectId) {
    throw AppError.notFound(
      "acceptance_criterion_not_found",
      "The requested acceptance criterion was not found in this project.",
      { projectId, criterionId },
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

/** Appends a new criterion at the end of the project's ordered list. */
export function addCriterion(
  db: Db,
  projectId: number,
  text: string,
  context?: MutationContext,
) {
  const trimmed = normalizeCriterionText(text);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    const maxPosition = tx
      .select({ position: schema.projectAcceptanceCriteria.position })
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
      .all()
      .reduce((max, c) => Math.max(max, c.position), -1);
    const criterion = tx
      .insert(schema.projectAcceptanceCriteria)
      .values({ projectId, text: trimmed, position: maxPosition + 1 })
      .returning()
      .get();
    touchProject(txDb, projectId);
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_acceptance_criterion_added",
      entityType: "project",
      entityTitle: project.title,
      projectId,
      metadata: {},
    });
    if (maxPosition === -1) {
      recordContribution(txDb, {
        activityEventId,
        actorMemberId: actor(context),
        category: "planning",
        reason: "project_outcome_added",
        entityType: "project",
        entityId: projectId,
        personalEligible: true,
      });
    }
    return criterion;
  });
}

/** Edits a criterion's text without changing its position/checked state. */
export function updateCriterionText(
  db: Db,
  projectId: number,
  criterionId: number,
  text: string,
  context?: MutationContext,
) {
  const trimmed = normalizeCriterionText(text);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    const criterion = getCriterionOrThrow(txDb, projectId, criterionId);
    if (criterion.text === trimmed) return criterion;
    tx.update(schema.projectAcceptanceCriteria)
      .set({ text: trimmed, updatedAt: nowIso() })
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .run();
    const updated = tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .get()!;
    touchProject(txDb, projectId);
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_acceptance_criterion_updated",
      entityType: "project",
      entityTitle: project.title,
      projectId,
      metadata: {},
    });
    return updated;
  });
}

/** Checks/unchecks a single criterion (completion itself stays manual). */
export function setCriterionChecked(
  db: Db,
  projectId: number,
  criterionId: number,
  checked: boolean,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    const criterion = getCriterionOrThrow(txDb, projectId, criterionId);
    if (criterion.checked === checked) return criterion;
    tx.update(schema.projectAcceptanceCriteria)
      .set({ checked, updatedAt: nowIso() })
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .run();
    const updated = tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .get()!;
    touchProject(txDb, projectId);
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_acceptance_criterion_checked",
      entityType: "project",
      entityTitle: project.title,
      projectId,
      metadata: { checked },
    });
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
  projectId: number,
  orderedCriterionIds: number[],
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getProjectOrThrow(txDb, projectId);
    const existing = tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
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
          projectId,
          requestedCriterionIds: orderedCriterionIds,
          existingCriterionIds: existing.map((criterion) => criterion.id),
        },
      );
    }
    orderedCriterionIds.forEach((criterionId, index) => {
      tx.update(schema.projectAcceptanceCriteria)
        .set({ position: index, updatedAt: nowIso() })
        .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
        .run();
    });
    touchProject(txDb, projectId);
    return tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
      .all()
      .sort((a, b) => a.position - b.position);
  });
}

/** Removes a criterion and compacts the remaining positions (no gaps). */
export function removeCriterion(
  db: Db,
  projectId: number,
  criterionId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    getCriterionOrThrow(txDb, projectId, criterionId);
    tx.delete(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .run();
    const remaining = tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
      .all()
      .sort((a, b) => a.position - b.position);
    remaining.forEach((criterion, index) => {
      if (criterion.position !== index) {
        tx.update(schema.projectAcceptanceCriteria)
          .set({ position: index, updatedAt: nowIso() })
          .where(eq(schema.projectAcceptanceCriteria.id, criterion.id))
          .run();
      }
    });
    touchProject(txDb, projectId);
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_acceptance_criterion_removed",
      entityType: "project",
      entityTitle: project.title,
      projectId,
      metadata: {},
    });
    if (remaining.length === 0) {
      neutralizeContribution(txDb, {
        activityEventId,
        reason: "project_outcome_added",
        entityType: "project",
        entityId: projectId,
      });
    }
  });
}
