/**
 * Goals & interventions domain layer (feature spec: docs/goals-and-interventions.md
 * §4, §5, §9). Mirrors the typed parse-schema → domain-mutation → transaction
 * flow of the rest of the API: routes/MCP tools validate input, then call these
 * helpers, each of which wraps a single SQLite transaction and enforces
 * optimistic concurrency via `expectedRevision`.
 *
 * Goals and interventions are a separate journal from `work_items`; they never
 * join the activity/contribution system, Review, or the task graph. The
 * `running | finished | reviewed` progression is derived at read time
 * (interventionState.ts), never stored.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  AssessmentBand,
  Goal,
  GoalScope,
  GoalWithInterventions,
  Intervention,
  InterventionAssessment,
  InterventionSource,
  InterventionType,
  InterventionView,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { isIsoCalendarDate } from "./calendarDate.js";
import { deriveInterventionState } from "./interventionState.js";
import { nowIso } from "./workItemShared.js";

type GoalRow = typeof schema.goals.$inferSelect;
type InterventionRow = typeof schema.interventions.$inferSelect;
type AssessmentRow = typeof schema.interventionAssessments.$inferSelect;

export interface GoalListFilter {
  ownerMemberId?: number;
  scope?: GoalScope;
}

export interface CreateGoalInput {
  title: string;
  notes?: string;
  scope?: GoalScope;
  ownerMemberId?: number | null;
  createdByMemberId?: number | null;
}

export interface UpdateGoalInput {
  title?: string;
  notes?: string;
  expectedRevision?: number;
}

export interface StartInterventionInput {
  type: InterventionType;
  commitment: string;
  rationale?: string;
  startDate: string;
  revisitDate: string;
  source?: InterventionSource;
}

export interface AdjustInterventionInput {
  type?: InterventionType;
  commitment?: string;
  rationale?: string;
  startDate?: string;
  revisitDate?: string;
  expectedRevision?: number;
}

export interface ManualAssessmentInput {
  band: AssessmentBand;
  rationaleMd: string;
  countedItemIds?: number[];
  digestWindowStart: string;
  digestWindowEnd: string;
  assessedAt?: string;
}

function mapGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    revision: row.revision,
    ownerMemberId: row.ownerMemberId,
    scope: row.scope,
    title: row.title,
    notes: row.notes,
    status: row.status,
    concludedAt: row.concludedAt,
    createdByMemberId: row.createdByMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapIntervention(row: InterventionRow): Intervention {
  return {
    id: row.id,
    revision: row.revision,
    goalId: row.goalId,
    type: row.type,
    commitment: row.commitment,
    rationale: row.rationale,
    startDate: row.startDate,
    revisitDate: row.revisitDate,
    status: row.status,
    concludedAt: row.concludedAt,
    backingTaskId: row.backingTaskId,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseCountedItemIds(json: string): number[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is number => typeof value === "number");
    }
  } catch {
    // Fall through to an empty list for a corrupt column value.
  }
  return [];
}

function mapAssessment(row: AssessmentRow): InterventionAssessment {
  return {
    id: row.id,
    interventionId: row.interventionId,
    assessedAt: row.assessedAt,
    band: row.band,
    rationaleMd: row.rationaleMd,
    digestWindowStart: row.digestWindowStart,
    digestWindowEnd: row.digestWindowEnd,
    countedItemIds: parseCountedItemIds(row.countedItemIdsJson),
    source: row.source,
    createdAt: row.createdAt,
  };
}

function assertGoalRevision(goal: GoalRow, expectedRevision: number | undefined): void {
  if (expectedRevision === undefined || expectedRevision === goal.revision) return;
  throw AppError.conflict(
    "stale_write_conflict",
    "This goal was changed by another client. Reload it before saving again.",
    { entityType: "goal", entityId: goal.id, expectedRevision, currentRevision: goal.revision },
  );
}

function assertInterventionRevision(
  intervention: InterventionRow,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined || expectedRevision === intervention.revision) return;
  throw AppError.conflict(
    "stale_write_conflict",
    "This intervention was changed by another client. Reload it before saving again.",
    {
      entityType: "intervention",
      entityId: intervention.id,
      expectedRevision,
      currentRevision: intervention.revision,
    },
  );
}

function requireGoalRow(db: Db, goalId: number): GoalRow {
  const row = db.select().from(schema.goals).where(eq(schema.goals.id, goalId)).get();
  if (!row) {
    throw AppError.notFound("goal_not_found", "The goal was not found.", { goalId });
  }
  return row;
}

function requireInterventionRow(db: Db, interventionId: number): InterventionRow {
  const row = db
    .select()
    .from(schema.interventions)
    .where(eq(schema.interventions.id, interventionId))
    .get();
  if (!row) {
    throw AppError.notFound("intervention_not_found", "The intervention was not found.", {
      interventionId,
    });
  }
  return row;
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw AppError.badRequest("goal_title_required", "A goal needs a title.");
  }
  return trimmed;
}

function assertInterventionDates(startDate: string, revisitDate: string): void {
  if (!isIsoCalendarDate(startDate) || !isIsoCalendarDate(revisitDate)) {
    throw AppError.badRequest(
      "intervention_revisit_invalid",
      "Start and revisit dates must use YYYY-MM-DD.",
      { startDate, revisitDate },
    );
  }
  if (revisitDate < startDate) {
    throw AppError.badRequest(
      "intervention_revisit_invalid",
      "The revisit date must not be before the start date.",
      { startDate, revisitDate },
    );
  }
}

// --- Reads -----------------------------------------------------------------

function interventionsForGoals(db: Db, goalIds: number[]): Map<number, InterventionRow[]> {
  const grouped = new Map<number, InterventionRow[]>();
  if (goalIds.length === 0) return grouped;
  const rows = db
    .select()
    .from(schema.interventions)
    .where(inArray(schema.interventions.goalId, goalIds))
    .orderBy(asc(schema.interventions.startDate), asc(schema.interventions.id))
    .all();
  for (const row of rows) {
    const list = grouped.get(row.goalId) ?? [];
    list.push(row);
    grouped.set(row.goalId, list);
  }
  return grouped;
}

function assessmentsForInterventions(
  db: Db,
  interventionIds: number[],
): Map<number, AssessmentRow[]> {
  const grouped = new Map<number, AssessmentRow[]>();
  if (interventionIds.length === 0) return grouped;
  const rows = db
    .select()
    .from(schema.interventionAssessments)
    .where(inArray(schema.interventionAssessments.interventionId, interventionIds))
    .orderBy(
      asc(schema.interventionAssessments.assessedAt),
      asc(schema.interventionAssessments.id),
    )
    .all();
  for (const row of rows) {
    const list = grouped.get(row.interventionId) ?? [];
    list.push(row);
    grouped.set(row.interventionId, list);
  }
  return grouped;
}

function buildInterventionView(
  intervention: InterventionRow,
  assessments: AssessmentRow[],
  today: string,
): InterventionView {
  const state = deriveInterventionState({
    revisitDate: intervention.revisitDate,
    hasAssessment: assessments.length > 0,
    today,
    concluded: intervention.status === "concluded",
  });
  return {
    ...mapIntervention(intervention),
    derivedState: state.derivedState,
    withinReviewWindow: state.withinReviewWindow,
    assessments: assessments.map(mapAssessment),
  };
}

function assembleGoals(db: Db, goalRows: GoalRow[], today: string): GoalWithInterventions[] {
  const interventionsByGoal = interventionsForGoals(
    db,
    goalRows.map((goal) => goal.id),
  );
  const allInterventions = [...interventionsByGoal.values()].flat();
  const assessmentsByIntervention = assessmentsForInterventions(
    db,
    allInterventions.map((intervention) => intervention.id),
  );
  return goalRows.map((goal) => ({
    ...mapGoal(goal),
    interventions: (interventionsByGoal.get(goal.id) ?? []).map((intervention) =>
      buildInterventionView(
        intervention,
        assessmentsByIntervention.get(intervention.id) ?? [],
        today,
      ),
    ),
  }));
}

export function listGoals(
  db: Db,
  filter: GoalListFilter,
  today: string,
): GoalWithInterventions[] {
  const conditions = [];
  if (filter.ownerMemberId !== undefined) {
    conditions.push(eq(schema.goals.ownerMemberId, filter.ownerMemberId));
  }
  if (filter.scope !== undefined) {
    conditions.push(eq(schema.goals.scope, filter.scope));
  }
  const rows = db
    .select()
    .from(schema.goals)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(schema.goals.id))
    .all();
  return assembleGoals(db, rows, today);
}

export function getGoal(db: Db, goalId: number, today: string): GoalWithInterventions {
  const row = requireGoalRow(db, goalId);
  return assembleGoals(db, [row], today)[0]!;
}

export interface GoalAccess {
  ownerMemberId: number;
  scope: GoalScope;
}

/**
 * Enforces the owner-and-scope visibility an MCP credential carries (§9): a
 * credential only ever sees its own owner's goals within its scope. Throws
 * `goal_not_found` rather than leaking existence across owners/scopes.
 */
export function assertGoalAccessible(db: Db, goalId: number, access: GoalAccess): void {
  const row = requireGoalRow(db, goalId);
  if (row.ownerMemberId !== access.ownerMemberId || row.scope !== access.scope) {
    throw AppError.notFound("goal_not_found", "The goal was not found.", { goalId });
  }
}

/** Same owner/scope guard as {@link assertGoalAccessible}, via the parent goal. */
export function assertInterventionAccessible(
  db: Db,
  interventionId: number,
  access: GoalAccess,
): void {
  const intervention = requireInterventionRow(db, interventionId);
  const goal = db
    .select()
    .from(schema.goals)
    .where(eq(schema.goals.id, intervention.goalId))
    .get();
  if (!goal || goal.ownerMemberId !== access.ownerMemberId || goal.scope !== access.scope) {
    throw AppError.notFound("intervention_not_found", "The intervention was not found.", {
      interventionId,
    });
  }
}

// --- Goal mutations --------------------------------------------------------

export function createGoal(db: Db, input: CreateGoalInput, today: string): GoalWithInterventions {
  const title = normalizeTitle(input.title);
  return db.transaction((tx) => {
    const created = tx
      .insert(schema.goals)
      .values({
        title,
        notes: input.notes ?? "",
        scope: input.scope ?? "work",
        ownerMemberId: input.ownerMemberId ?? null,
        createdByMemberId: input.createdByMemberId ?? null,
      })
      .returning()
      .get();
    return assembleGoals(tx, [created], today)[0]!;
  });
}

export function updateGoal(
  db: Db,
  goalId: number,
  input: UpdateGoalInput,
  today: string,
): GoalWithInterventions {
  const title = input.title === undefined ? undefined : normalizeTitle(input.title);
  return db.transaction((tx) => {
    const current = requireGoalRow(tx, goalId);
    assertGoalRevision(current, input.expectedRevision);
    const patch: Partial<GoalRow> = { revision: current.revision + 1, updatedAt: nowIso() };
    if (title !== undefined) patch.title = title;
    if (input.notes !== undefined) patch.notes = input.notes;
    tx.update(schema.goals).set(patch).where(eq(schema.goals.id, goalId)).run();
    return assembleGoals(tx, [requireGoalRow(tx, goalId)], today)[0]!;
  });
}

export function concludeGoal(
  db: Db,
  goalId: number,
  expectedRevision: number | undefined,
  today: string,
): GoalWithInterventions {
  return db.transaction((tx) => {
    const current = requireGoalRow(tx, goalId);
    assertGoalRevision(current, expectedRevision);
    if (current.status === "concluded") {
      throw AppError.conflict(
        "goal_transition_invalid",
        "This goal is already concluded.",
        { goalId },
      );
    }
    tx.update(schema.goals)
      .set({
        status: "concluded",
        concludedAt: nowIso(),
        revision: current.revision + 1,
        updatedAt: nowIso(),
      })
      .where(eq(schema.goals.id, goalId))
      .run();
    return assembleGoals(tx, [requireGoalRow(tx, goalId)], today)[0]!;
  });
}

// --- Intervention mutations ------------------------------------------------

export function startIntervention(
  db: Db,
  goalId: number,
  input: StartInterventionInput,
  today: string,
): InterventionView {
  const commitment = input.commitment.trim();
  if (commitment.length === 0) {
    throw AppError.badRequest(
      "intervention_commitment_required",
      "An intervention needs a one-line commitment.",
    );
  }
  assertInterventionDates(input.startDate, input.revisitDate);
  return db.transaction((tx) => {
    requireGoalRow(tx, goalId);
    const created = tx
      .insert(schema.interventions)
      .values({
        goalId,
        type: input.type,
        commitment,
        rationale: input.rationale ?? "",
        startDate: input.startDate,
        revisitDate: input.revisitDate,
        source: input.source ?? "manual",
      })
      .returning()
      .get();
    return buildInterventionView(created, [], today);
  });
}

export function adjustIntervention(
  db: Db,
  interventionId: number,
  input: AdjustInterventionInput,
  today: string,
): InterventionView {
  const commitment =
    input.commitment === undefined ? undefined : input.commitment.trim();
  if (commitment !== undefined && commitment.length === 0) {
    throw AppError.badRequest(
      "intervention_commitment_required",
      "An intervention needs a one-line commitment.",
    );
  }
  return db.transaction((tx) => {
    const current = requireInterventionRow(tx, interventionId);
    assertInterventionRevision(current, input.expectedRevision);
    const startDate = input.startDate ?? current.startDate;
    const revisitDate = input.revisitDate ?? current.revisitDate;
    if (input.startDate !== undefined || input.revisitDate !== undefined) {
      assertInterventionDates(startDate, revisitDate);
    }
    const patch: Partial<InterventionRow> = {
      revision: current.revision + 1,
      updatedAt: nowIso(),
    };
    if (input.type !== undefined) patch.type = input.type;
    if (commitment !== undefined) patch.commitment = commitment;
    if (input.rationale !== undefined) patch.rationale = input.rationale;
    if (input.startDate !== undefined) patch.startDate = input.startDate;
    if (input.revisitDate !== undefined) patch.revisitDate = input.revisitDate;
    tx.update(schema.interventions)
      .set(patch)
      .where(eq(schema.interventions.id, interventionId))
      .run();
    const updated = requireInterventionRow(tx, interventionId);
    const assessments = assessmentsForInterventions(tx, [interventionId]).get(interventionId) ?? [];
    return buildInterventionView(updated, assessments, today);
  });
}

export function concludeIntervention(
  db: Db,
  interventionId: number,
  expectedRevision: number | undefined,
  today: string,
): InterventionView {
  return db.transaction((tx) => {
    const current = requireInterventionRow(tx, interventionId);
    assertInterventionRevision(current, expectedRevision);
    if (current.status === "concluded") {
      throw AppError.conflict(
        "intervention_transition_invalid",
        "This intervention is already concluded.",
        { interventionId },
      );
    }
    tx.update(schema.interventions)
      .set({
        status: "concluded",
        concludedAt: nowIso(),
        revision: current.revision + 1,
        updatedAt: nowIso(),
      })
      .where(eq(schema.interventions.id, interventionId))
      .run();
    const updated = requireInterventionRow(tx, interventionId);
    const assessments = assessmentsForInterventions(tx, [interventionId]).get(interventionId) ?? [];
    return buildInterventionView(updated, assessments, today);
  });
}

export function createManualAssessment(
  db: Db,
  interventionId: number,
  input: ManualAssessmentInput,
): InterventionAssessment {
  if (input.rationaleMd.trim().length === 0) {
    throw AppError.badRequest(
      "intervention_assessment_invalid",
      "An assessment needs a rationale.",
    );
  }
  if (!isIsoCalendarDate(input.digestWindowStart) || !isIsoCalendarDate(input.digestWindowEnd)) {
    throw AppError.badRequest(
      "intervention_assessment_invalid",
      "Assessment window dates must use YYYY-MM-DD.",
      { digestWindowStart: input.digestWindowStart, digestWindowEnd: input.digestWindowEnd },
    );
  }
  if (input.digestWindowEnd < input.digestWindowStart) {
    throw AppError.badRequest(
      "intervention_assessment_invalid",
      "The assessment window end must not be before its start.",
      { digestWindowStart: input.digestWindowStart, digestWindowEnd: input.digestWindowEnd },
    );
  }
  const countedItemIds = input.countedItemIds ?? [];
  return db.transaction((tx) => {
    requireInterventionRow(tx, interventionId);
    const created = tx
      .insert(schema.interventionAssessments)
      .values({
        interventionId,
        assessedAt: input.assessedAt ?? nowIso(),
        band: input.band,
        rationaleMd: input.rationaleMd,
        digestWindowStart: input.digestWindowStart,
        digestWindowEnd: input.digestWindowEnd,
        countedItemIdsJson: JSON.stringify(countedItemIds),
        source: "manual",
      })
      .returning()
      .get();
    return mapAssessment(created);
  });
}
