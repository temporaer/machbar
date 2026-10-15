import { buildInterventionEvidence } from "./interventionEvidence.js";
import { addCalendarDays } from "./calendarDate.js";
import { householdToday } from "./householdCalendar.js";
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
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  InterventionTaskPlan,
  ObservationPlan,
  AssessmentBand,
  Goal,
  GoalArea,
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
import { createTaskInTransaction } from "./taskCrud.js";
import { cancelTask } from "./taskWorkflow.js";
import { setObservationPlan } from "./interventionObservations.js";
import { type MutationContext, nowIso } from "./workItemShared.js";

type GoalRow = typeof schema.goals.$inferSelect;
type InterventionRow = typeof schema.interventions.$inferSelect;
type AssessmentRow = typeof schema.interventionAssessments.$inferSelect;

export interface GoalListFilter {
  ownerMemberId?: number;
  area?: GoalArea;
}

export interface CreateGoalInput {
  title: string;
  notes?: string;
  area?: GoalArea;
  ownerMemberId?: number | null;
  createdByMemberId?: number | null;
}

export interface UpdateGoalInput {
  title?: string;
  notes?: string;
  area?: GoalArea;
  expectedRevision?: number;
}

export interface StartInterventionInput {
  observationPlan?: ObservationPlan;
  type: InterventionType;
  commitment: string;
  rationale?: string;
  startDate: string;
  revisitDate: string;
  source?: InterventionSource;
}

export interface AdjustInterventionInput {
  observationPlan?: ObservationPlan;
  type?: InterventionType;
  commitment?: string;
  rationale?: string;
  startDate?: string;
  revisitDate?: string;
  expectedRevision?: number;
}

export interface ManualAssessmentInput {
  reviewKey?: string;
  decision?: "continue" | "adjust" | "stop";
  benefit?: "helped" | "not_helped" | "uncertain";
  obstacle?: string;
  expectedRevision?: number;
  nextRevisitDate?: string;
  backingCleanup?: BackingCleanup;
  observationPlan?: ObservationPlan;
  commitment?: string;
  band: AssessmentBand;
  rationaleMd: string;
  countedItemIds?: number[];
  digestWindowStart: string;
  digestWindowEnd: string;
  assessedAt?: string;
}

/**
 * Phase 4 recurring-task backing (§8). Only `frequency_habit` interventions may
 * be backed. The recurring check-in is created through the canonical task path
 * ({@link createTaskInTransaction}) — never a parallel mutation — using the
 * caller-chosen cadence (defaulting to a daily check-in).
 */
export interface BackInterventionInput {
  tasks?: InterventionTaskPlan[];
  title?: string;
  scheduledDate?: string;
  repeatAfterDays?: number;
  allowedDeviationDays?: number;
  expectedRevision?: number;
}

/**
 * How to treat a backed intervention's recurring check-in when the intervention
 * concludes (§8, decided). Defaults to `"stop"`: silently orphaning the task
 * would be surprising, so the default ends it, while `"keep"` lets a habit with
 * standing value live on as ordinary recurring work.
 */
export type BackingCleanup = "keep" | "stop";

function mapGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    revision: row.revision,
    ownerMemberId: row.ownerMemberId,
    area: row.area,
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
    reviewWindowStart: row.reviewWindowStart,
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
    reviewKey: row.reviewKey, decision: row.decision, benefit: row.benefit, obstacle: row.obstacle, evidence: row.evidence,
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
  db: Db,
  intervention: InterventionRow,
  assessments: AssessmentRow[],
  today: string,
): InterventionView {
  const state = deriveInterventionState({
    revisitDate: intervention.revisitDate,
    hasAssessment: intervention.status === "concluded" && assessments.length > 0,
    today,
    concluded: intervention.status === "concluded",
  });
  return {
    ...mapIntervention(intervention),
    generatedTasks: db.select().from(schema.interventionTasks).where(eq(schema.interventionTasks.interventionId, intervention.id)).all(),
    observationPlan: db.select().from(schema.interventionObservationPlans).where(eq(schema.interventionObservationPlans.interventionId, intervention.id)).orderBy(desc(schema.interventionObservationPlans.effectiveFrom)).get()?.plan,
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
        db, intervention,
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
  if (filter.area !== undefined) {
    conditions.push(eq(schema.goals.area, filter.area));
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
}

/**
 * Enforces the owner-only visibility an MCP credential carries (§9): goals are
 * always owner-scoped per-user, so a credential only ever sees its own owner's
 * goals — regardless of each goal's `area`. Throws `goal_not_found` rather than
 * leaking existence across owners.
 */
export function assertGoalAccessible(db: Db, goalId: number, access: GoalAccess): void {
  const row = requireGoalRow(db, goalId);
  if (row.ownerMemberId !== access.ownerMemberId) {
    throw AppError.notFound("goal_not_found", "The goal was not found.", { goalId });
  }
}

/** Same owner guard as {@link assertGoalAccessible}, via the parent goal. */
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
  if (!goal || goal.ownerMemberId !== access.ownerMemberId) {
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
        area: input.area ?? "personal",
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
    if (input.area !== undefined) patch.area = input.area;
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
    if (input.observationPlan) {
      const owner = requireGoalRow(tx, goalId).ownerMemberId;
      if (owner === null) throw AppError.badRequest("goal_owner_required", "An observation plan needs an owner.");
      setObservationPlan(tx as unknown as Db, created.id, { plan: input.observationPlan, expectedRevision: created.revision }, { ownerMemberId: owner });
    }
    return buildInterventionView(tx as unknown as Db, requireInterventionRow(tx, created.id), [], today);
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
    const previousPlan = tx.select().from(schema.interventionObservationPlans).where(eq(schema.interventionObservationPlans.interventionId, interventionId)).orderBy(desc(schema.interventionObservationPlans.effectiveFrom)).get()?.plan;
    const plan = input.observationPlan ?? (commitment !== undefined && commitment !== current.commitment ? previousPlan : undefined);
    if (plan) {
      const owner = requireGoalRow(tx, current.goalId).ownerMemberId;
      if (owner === null) throw AppError.badRequest("goal_owner_required", "An observation plan needs an owner.");
      setObservationPlan(tx as unknown as Db, interventionId, { plan, expectedRevision: current.revision + 1 }, { ownerMemberId: owner });
    }
    const updated = requireInterventionRow(tx, interventionId);
    const assessments = assessmentsForInterventions(tx, [interventionId]).get(interventionId) ?? [];
    return buildInterventionView(tx as unknown as Db, updated, assessments, today);
  });
}

/** Atomically create ordinary work with bounded provenance through canonical task creation. */
export function backIntervention(
  db: Db, interventionId: number, input: BackInterventionInput, today: string, context?: MutationContext,
): InterventionView {
  return db.transaction((tx) => {
    const current = requireInterventionRow(tx, interventionId);
    const existing = tx.select().from(schema.interventionTasks).where(eq(schema.interventionTasks.interventionId, interventionId)).all();
    const tasks = input.tasks ?? [{ key: "legacy-check-in", title: (input.title ?? current.commitment).trim(),
      scheduledDate: input.scheduledDate ?? (current.startDate < today ? today : current.startDate),
      ...(current.type === "frequency_habit" ? { repeatAfterDays: input.repeatAfterDays ?? 1, allowedDeviationDays: input.allowedDeviationDays ?? 0 } : {}),
    }];
    if (new Set(tasks.map((t) => t.key)).size !== tasks.length || tasks.length > 8) throw AppError.badRequest("intervention_backing_unavailable", "Each generated task needs a unique key; at most eight tasks per acceptance.");
    // Stable proposal-local keys make an identical retry a read, even after a lost response.
    if (tasks.every((task) => existing.some((row) => row.key === task.key && JSON.stringify(row.input) === JSON.stringify(task)))) {
      const assessments = assessmentsForInterventions(tx, [interventionId]).get(interventionId) ?? [];
      return buildInterventionView(tx as unknown as Db, current, assessments, today);
    }
    assertInterventionRevision(current, input.expectedRevision);
    if (current.status === "concluded") throw AppError.conflict("intervention_transition_invalid", "A concluded intervention cannot create tasks.");
    if (existing.length + tasks.length > 16 || tasks.some((t) => existing.some((row) => row.key === t.key))) throw AppError.conflict("intervention_already_backed", "These task keys were already accepted or the intervention already has sixteen generated tasks.");
    const goal = requireGoalRow(tx, current.goalId);
    if (goal.ownerMemberId === null) throw AppError.badRequest("goal_owner_required", "An owner is required before creating private tasks.");
    let firstTaskId = current.backingTaskId;
    for (const task of tasks) {
      const { key, ...taskInput } = task;
      const created = createTaskInTransaction(tx as unknown as Db, {
        ...taskInput, ...(taskInput.repeatAfterDays ? { allowedDeviationDays: taskInput.allowedDeviationDays ?? 0 } : {}), status: "actionable", scope: goal.area === "work" ? "work" : "household",
        privacyOwnerMemberId: goal.ownerMemberId, ownerMemberId: goal.ownerMemberId, ownerInheritanceMode: "explicit",
        createdByMemberId: context?.actorMemberId ?? null,
      }, context);
      tx.insert(schema.interventionTasks).values({ interventionId, key, taskId: created.id, originalTaskId: created.id, title: task.title, input: task }).run();
      firstTaskId ??= created.id;
    }
    tx.update(schema.interventions).set({ backingTaskId: firstTaskId, revision: current.revision + 1, updatedAt: nowIso() }).where(eq(schema.interventions.id, interventionId)).run();
    const assessments = assessmentsForInterventions(tx, [interventionId]).get(interventionId) ?? [];
    return buildInterventionView(tx as unknown as Db, requireInterventionRow(tx, interventionId), assessments, today);
  });
}

export function concludeIntervention(
  db: Db,
  interventionId: number,
  expectedRevision: number | undefined,
  today: string,
  options: { backingCleanup?: BackingCleanup; context?: MutationContext } = {},
): InterventionView {
  const backingCleanup: BackingCleanup = options.backingCleanup ?? "stop";
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
    // Cleanup on conclude (§8, decided): resolve the backing recurring check-in
    // before flipping status. "keep" just clears the pointer so the task lives
    // on as ordinary recurring work; "stop" (default) ends it through the
    // canonical task path — never a parallel mutation — leaving no orphan.
    if (backingCleanup === "stop") {
      const generated = tx.select().from(schema.interventionTasks).where(eq(schema.interventionTasks.interventionId, interventionId)).all();
      for (const row of generated) {
        if (row.taskId === null) continue;
        const task = tx.select().from(schema.workItems).where(eq(schema.workItems.id, row.taskId)).get();
        if (task && task.status !== "done" && task.status !== "cancelled") cancelTask(tx as unknown as Db, row.taskId, undefined, options.context);
      }
    }
    tx.update(schema.interventions)
      .set({
        status: "concluded",
        concludedAt: nowIso(),
        backingTaskId: null,
        revision: current.revision + 1,
        updatedAt: nowIso(),
      })
      .where(eq(schema.interventions.id, interventionId))
      .run();
    const updated = requireInterventionRow(tx, interventionId);
    const assessments = assessmentsForInterventions(tx, [interventionId]).get(interventionId) ?? [];
    return buildInterventionView(tx as unknown as Db, updated, assessments, today);
  });
}

export function createManualAssessment(
  db: Db,
  interventionId: number,
  input: ManualAssessmentInput,
): InterventionAssessment {
  return insertAssessment(db, interventionId, input, "manual");
}

/**
 * Shared assessment-authoring path for both the manual self-assessment (§5) and
 * an accepted coach `intervention_assess` proposal (§7.2). The only difference
 * is the `source` stamped on the row; validation and the single-transaction
 * insert are identical, so there is exactly one canonical write path.
 */
export function insertAssessment(
  db: Db,
  interventionId: number,
  input: ManualAssessmentInput,
  source: InterventionSource,
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
    const current = requireInterventionRow(tx, interventionId);
    if (input.reviewKey) {
      const existing = tx.select().from(schema.interventionAssessments).where(and(eq(schema.interventionAssessments.interventionId, interventionId), eq(schema.interventionAssessments.reviewKey, input.reviewKey))).get();
      if (existing) return mapAssessment(existing);
    }
    if (input.decision && (!input.reviewKey || input.expectedRevision === undefined)) throw AppError.badRequest("intervention_assessment_invalid", "A checkpoint decision needs its revision and stable acceptance key.");
    if (input.decision) assertInterventionRevision(current, input.expectedRevision);
    const owner = requireGoalRow(tx, current.goalId).ownerMemberId;
    const evidence = owner === null ? null : buildInterventionEvidence(tx as unknown as Db, interventionId, { ownerMemberId: owner }, { startDate: input.digestWindowStart, endDate: input.digestWindowEnd });
    if (input.decision) {
      if (current.status !== "active") throw AppError.conflict("intervention_transition_invalid", "This behavior has already stopped.");
      if (input.digestWindowStart !== (current.reviewWindowStart ?? current.startDate)) throw AppError.conflict("stale_write_conflict", "This review window has already advanced.");
      if (input.decision === "stop") {
        if (current.backingTaskId !== null && input.backingCleanup === undefined) throw AppError.badRequest("intervention_assessment_invalid", "Choose whether to keep or stop generated tasks.");
        concludeIntervention(tx as unknown as Db, interventionId, current.revision, householdToday(tx as unknown as Db), { backingCleanup: input.backingCleanup });
      } else {
        const today = householdToday(tx as unknown as Db);
        const next = input.nextRevisitDate ?? addCalendarDays(today, 14);
        if (!isIsoCalendarDate(next) || next <= today || next <= input.digestWindowEnd) throw AppError.badRequest("intervention_revisit_invalid", "The next checkpoint must be in the future.");
        if (input.decision === "adjust") adjustIntervention(tx as unknown as Db, interventionId, { ...(input.commitment ? { commitment: input.commitment } : {}), ...(input.observationPlan ? { observationPlan: input.observationPlan } : {}), expectedRevision: current.revision }, today);
        const updated = requireInterventionRow(tx, interventionId);
        tx.update(schema.interventions).set({ revisitDate: next, reviewWindowStart: addCalendarDays(input.digestWindowEnd, 1), revision: updated.revision + 1, updatedAt: nowIso() }).where(eq(schema.interventions.id, interventionId)).run();
      }
    }
    const created = tx
      .insert(schema.interventionAssessments)
      .values({
        interventionId,
        reviewKey: input.reviewKey, decision: input.decision, benefit: input.benefit, obstacle: input.obstacle ?? "", evidence,
        assessedAt: input.assessedAt ?? nowIso(),
        band: input.band,
        rationaleMd: input.rationaleMd,
        digestWindowStart: input.digestWindowStart,
        digestWindowEnd: input.digestWindowEnd,
        countedItemIdsJson: JSON.stringify(countedItemIds),
        source,
      })
      .returning()
      .get();
    return mapAssessment(created);
  });
}
