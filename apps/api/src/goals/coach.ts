import { buildInterventionEvidence } from "../domain/interventionEvidence.js";
import type { InterventionEvidence, InterventionReviewDecision } from "@machbar/shared";
import type { ManualAssessmentInput } from "../domain/goals.js";
import { requestAssessmentSchema } from "../schemas.js";
import { z } from "zod";
import { observationPlanSchema, interventionTaskPlanSchema, requestGoalSuggestionSchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";
/**
 * Advisory goal coach AI passes (docs/goals-and-interventions.md §7, §9).
 *
 * Two passes, each paired with a Home Assistant AI Task exactly like intake and
 * the Klärungsrunde: `goal_suggest` proposes interventions for a goal, and
 * `intervention_assess` reviews a finished experiment over its own period. Both
 * are *proposal-not-applied*: the request row stores a normalized proposal and
 * NOTHING mutates the goals journal until an explicit accept, which performs a
 * single atomic write through the canonical Phase 1 domain path.
 *
 * The proposal lives entirely on the `home_assistant_requests` row — the owner
 * (goal/intervention) is read back from the stored payload, so Phase 3 needs no
 * schema change beyond two new `kind` enum values. When no AI is configured the
 * two Klärungsrunde guards fire and the manual Phase 1-2 path is unaffected.
 */
import { desc, eq } from "drizzle-orm";
import type {
  ObservationPlan,
  InterventionTaskPlan,
  AssessmentBand,
  AssessmentProposal,
  CoachRequestStatus,
  GoalSuggestAiResponse,
  GoalAssessAiResponse,
  GoalSuggestionProposal,
  InterventionType,
  ProposedIntervention,
} from "@machbar/shared";
import { assessmentBands, interventionTypes } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { getHouseholdAiContext } from "../aiContext.js";
import { householdToday } from "../domain/householdCalendar.js";
import { isIsoCalendarDate, addCalendarDays } from "../domain/calendarDate.js";
import { backIntervention, getGoal, insertAssessment, startIntervention } from "../domain/goals.js";
import { activeHomeAssistantIntegration } from "../integrations/homeAssistant.js";
import {
  enqueueHomeAssistantRequest,
  type HomeAssistantRequestSignal,
} from "../integrations/homeAssistantRequests.js";
import {
  assessCandidateItemIds,
  buildGoalSuggestInstructions,
  buildInterventionAssessInstructions,
  summarizeAssessDigest,
} from "./coachPrompt.js";

const TASK_NAME = "Machbar Zielcoach" as const;
const DEFAULT_DURATION_DAYS = 14;

type GoalRow = typeof schema.goals.$inferSelect;
type InterventionRow = typeof schema.interventions.$inferSelect;
type RequestRow = typeof schema.homeAssistantRequests.$inferSelect;

interface StoredSuggestPayload {
  contractVersion?: 2;
  clarification?: { question: string; answer: string };
  goalId: number;
  taskName: typeof TASK_NAME;
  instructions: string;
}

interface StoredAssessPayload {
  contractVersion?: 2;
  evidence?: InterventionEvidence;
  expectedRevision?: number;
  reflection?: { benefit?: "helped" | "not_helped" | "uncertain"; obstacle?: string };
  candidateObservationIds?: number[];
  interventionId: number;
  taskName: typeof TASK_NAME;
  instructions: string;
  windowStart: string;
  windowEnd: string;
  candidateItemIds: number[];
}

/** Normalized, validated proposals stored on the request row's `resultJson`. */
interface StoredSuggestProposal {
  clarificationQuestion?: string | null;
  acceptedInterventionId?: number;
  interventions: ProposedIntervention[];
}
interface StoredAssessProposal {
  reminderEnabled?: boolean;
  countedObservationIds?: number[];
  recommendedDecision?: InterventionReviewDecision;
  observationPlan?: ObservationPlan;
  commitment?: string;
  nextRevisitDate?: string;
  band: AssessmentBand;
  rationaleMd: string;
  countedItemIds: number[];
  nextMove: string | null;
}

/** Overrides a user may apply when accepting a suggested intervention. */
export interface AcceptSuggestionInput {
  observationPlan?: ObservationPlan;
  tasks?: InterventionTaskPlan[];
  index?: number;
  type?: InterventionType;
  commitment?: string;
  rationale?: string;
  startDate?: string;
  revisitDate?: string;
}

/** Overrides a user may apply when accepting an assessment proposal. */
export type AcceptAssessmentInput = Partial<Omit<ManualAssessmentInput, "digestWindowStart" | "digestWindowEnd" | "evidence" | "reviewKey">>;

// --- Shared guards & helpers ------------------------------------------------

/**
 * Same readiness guard as the Klärungsrunde (cleanupRound/jobs.ts): a connected,
 * current integration with a usable AI Task. Throws `home_assistant_not_connected`
 * / `home_assistant_protocol_outdated` / `ai_task_not_configured` so the coach
 * degrades gracefully and the manual path keeps working untouched.
 */
function readyIntegration(db: Db) {
  const integration = activeHomeAssistantIntegration(db);
  if (!integration) {
    throw AppError.conflict("home_assistant_not_connected", "Home Assistant is not connected.");
  }
  if (integration.protocolVersion !== 3) {
    throw AppError.conflict(
      "home_assistant_protocol_outdated",
      "The Home Assistant integration must be updated.",
    );
  }
  const capabilities = integration.capabilitiesJson
    ? (JSON.parse(integration.capabilitiesJson) as { aiTask?: { state?: string } })
    : null;
  if (capabilities?.aiTask?.state && capabilities.aiTask.state !== "ok") {
    throw AppError.conflict("ai_task_not_configured", "No usable Home Assistant AI Task is configured.");
  }
  return integration;
}

function goalRowOrThrow(db: Db, goalId: number): GoalRow {
  const row = db.select().from(schema.goals).where(eq(schema.goals.id, goalId)).get();
  if (!row) throw AppError.notFound("goal_not_found", "The goal was not found.", { goalId });
  return row;
}

function interventionRowOrThrow(db: Db, interventionId: number): InterventionRow {
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

/** Owner-scopes the coach to the viewer, mirroring the Phase 1 goal guards. */
function assertGoalOwner(goal: GoalRow, ownerMemberId: number | null): void {
  if (ownerMemberId === null || goal.ownerMemberId !== ownerMemberId) {
    throw AppError.notFound("goal_not_found", "The goal was not found.", { goalId: goal.id });
  }
}

function parseResult<T>(json: string | null): T | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function deriveStatus(row: RequestRow): CoachRequestStatus {
  if (row.status === "queued") return "queued";
  if (row.status === "leased") return "analyzing";
  if (row.status === "succeeded") return "ready";
  return "failed";
}

function errorMessage(row: RequestRow): string | null {
  if (row.status !== "failed") return null;
  const error = parseResult<{ message?: string }>(row.error);
  return error?.message ?? "The AI Task did not return a usable result.";
}

// --- Validation -------------------------------------------------------------

function validateSuggestResponse(raw: unknown, today: string, strict = false, allowClarification = true): StoredSuggestProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const response = raw as GoalSuggestAiResponse;
  if (!Array.isArray(response.interventions) || response.interventions.length > 2) return null;
  if (response.clarificationQuestion != null) {
    if (!allowClarification || response.interventions.length || typeof response.clarificationQuestion !== "string" || !response.clarificationQuestion.trim() || response.clarificationQuestion.length > 500) return null;
    return { clarificationQuestion: response.clarificationQuestion.trim(), interventions: [] };
  }
  const entrySchema = z.object({
    type: z.enum(interventionTypes), commitment: z.string().trim().min(1).max(1000), rationale: z.string().trim().max(4000),
    startDate: z.string().refine(isIsoCalendarDate), revisitDate: z.string().refine(isIsoCalendarDate),
    observationPlan: observationPlanSchema.optional(), tasks: z.array(interventionTaskPlanSchema).max(8).optional(),
  }).strict();
  const interventions: ProposedIntervention[] = [];
  for (const rawEntry of response.interventions) {
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) return null;
    const value = entry.data;
    if (strict && !value.observationPlan) return null;
    if (value.revisitDate < value.startDate) return null;
    if (value.tasks?.some((t) => t.repeatAfterDays && !t.scheduledDate)) return null;
    if (value.tasks?.some((t) => t.reminders?.some((r) => r.kind === "deadline_relative") && !t.dueDate && !t.repeatAfterDays)) return null;
    if (value.tasks?.some((t) => t.dueDate && t.scheduledDate && t.dueDate < t.scheduledDate)) return null;
    if (new Set(value.tasks?.map((t) => t.key)).size !== (value.tasks?.length ?? 0)) return null;
    interventions.push(value);
  }
  return interventions.length ? { interventions } : null;
}

function validateAssessResponse(
  raw: unknown,
  candidateItemIds: number[],
  candidateObservationIds: number[] = [],
  strict = false,
): StoredAssessProposal | null {
  const response = raw as GoalAssessAiResponse | null | undefined;
  if (!response || typeof response !== "object") return null;
  const band = response.band as AssessmentBand;
  if (!assessmentBands.includes(band)) return null;
  const rationaleMd = typeof response.rationaleMd === "string" ? response.rationaleMd.trim() : "";
  if (rationaleMd.length === 0) return null;
  const allowed = new Set(candidateItemIds);
  const countedItemIds = Array.isArray(response.countedItemIds)
    ? response.countedItemIds.filter(
        (value): value is number => typeof value === "number" && allowed.has(value),
      )
    : [];
  const nextMove =
    typeof response.nextMove === "string" && response.nextMove.trim().length > 0
      ? response.nextMove.trim()
      : null;
  if (response.commitment !== undefined && (typeof response.commitment !== "string" || !response.commitment.trim() || response.commitment.length > 1000)) return null;
  if (strict && !Array.isArray(response.countedItemIds)) return null;
  const refs = response.countedObservationIds ?? [];
  if (!Array.isArray(refs) || refs.some((id) => !Number.isInteger(id) || !candidateObservationIds.includes(id))) return null;
  if (strict && (!Array.isArray(response.countedObservationIds) || !["continue", "adjust", "stop"].includes(response.recommendedDecision ?? ""))) return null;
  if (strict && Array.isArray(response.countedItemIds) && response.countedItemIds.some((id) => !allowed.has(id))) return null;
  const plan = response.observationPlan === undefined ? undefined : observationPlanSchema.safeParse(response.observationPlan);
  if (plan && !plan.success) return null;
  if (response.nextRevisitDate !== undefined && !isIsoCalendarDate(response.nextRevisitDate)) return null;
  if (response.recommendedDecision === "adjust" && !response.commitment?.trim() && !plan && response.reminderEnabled === undefined) return null;
  if (response.reminderEnabled !== undefined && typeof response.reminderEnabled !== "boolean") return null;
  return { band, rationaleMd, countedItemIds, nextMove, countedObservationIds: refs,
    reminderEnabled: response.reminderEnabled,
    recommendedDecision: response.recommendedDecision, observationPlan: plan?.success ? plan.data : undefined,
    commitment: response.commitment?.trim(), nextRevisitDate: response.nextRevisitDate };
}

// --- Suggest: request / read / analyze / accept -----------------------------

export function requestGoalSuggestion(
  db: Db,
  goalId: number,
  ownerMemberId: number | null,
  signal?: HomeAssistantRequestSignal,
  rawOptions: { clarificationRequestId?: string; clarificationAnswer?: string } = {},
): string {
  const options = parseOrThrow(requestGoalSuggestionSchema, rawOptions);
  const integration = readyIntegration(db);
  const goal = goalRowOrThrow(db, goalId);
  assertGoalOwner(goal, ownerMemberId);
  let clarification: { question: string; answer: string } | undefined;
  if (options.clarificationRequestId) {
    const previous = suggestRowOrThrow(db, goalId, options.clarificationRequestId);
    const previousPayload = parseResult<StoredSuggestPayload>(previous.payloadJson);
    const previousProposal = parseResult<StoredSuggestProposal>(previous.resultJson);
    if (deriveStatus(previous) !== "ready" || !previousProposal?.clarificationQuestion || previousPayload?.clarification) throw AppError.conflict("coach_proposal_not_ready", "Only one clarification exchange is supported.");
    clarification = { question: previousProposal.clarificationQuestion, answer: options.clarificationAnswer! };
  }
  const today = householdToday(db);
  const payload: StoredSuggestPayload = {
    contractVersion: 2,
    ...(clarification ? { clarification } : {}),
    goalId,
    taskName: TASK_NAME,
    instructions: buildGoalSuggestInstructions({
      goal: { title: goal.title, notes: goal.notes, area: goal.area },
      today,
      defaultRevisitDate: addCalendarDays(today, DEFAULT_DURATION_DAYS),
      aiContext: getHouseholdAiContext(db),
      clarification,
    }),
  };
  return db.transaction((tx) =>
    enqueueHomeAssistantRequest(
      tx,
      { kind: "goal_suggest", integrationId: integration.id, payload },
      signal,
    ),
  );
}

function suggestRowOrThrow(db: Db, goalId: number, requestId: string): RequestRow {
  const row = db
    .select()
    .from(schema.homeAssistantRequests)
    .where(eq(schema.homeAssistantRequests.id, requestId))
    .get();
  const payload = row ? parseResult<StoredSuggestPayload>(row.payloadJson) : null;
  if (!row || row.kind !== "goal_suggest" || payload?.goalId !== goalId) {
    throw AppError.notFound("coach_request_not_found", "The suggestion request was not found.", {
      goalId,
      requestId,
    });
  }
  return row;
}

export function getGoalSuggestion(
  db: Db,
  goalId: number,
  requestId: string,
  ownerMemberId: number | null,
): GoalSuggestionProposal {
  assertGoalOwner(goalRowOrThrow(db, goalId), ownerMemberId);
  const row = suggestRowOrThrow(db, goalId, requestId);
  const status = deriveStatus(row);
  const proposal = status === "ready" ? parseResult<StoredSuggestProposal>(row.resultJson) : null;
  return {
    requestId,
    goalId,
    status,
    clarificationQuestion: proposal?.clarificationQuestion ?? null,
    interventions: proposal?.interventions ?? [],
    error: errorMessage(row),
  };
}

/** Owner handler: validate the AI output and store (or fail) the proposal. */
export function onGoalSuggestAnalyzed(db: Db, row: RequestRow, raw: unknown): void {
  const today = householdToday(db);
  const payload = parseResult<StoredSuggestPayload>(row.payloadJson);
  const proposal = validateSuggestResponse(raw, today, payload?.contractVersion === 2, !payload?.clarification);
  if (!proposal) {
    db.update(schema.homeAssistantRequests)
      .set({
        status: "failed",
        resultJson: null,
        error: JSON.stringify({
          code: "ai_task_invalid_response",
          message: "The AI Task did not return a usable intervention proposal.",
        }),
      })
      .where(eq(schema.homeAssistantRequests.id, row.id))
      .run();
    return;
  }
  db.update(schema.homeAssistantRequests)
    .set({ resultJson: JSON.stringify(proposal) })
    .where(eq(schema.homeAssistantRequests.id, row.id))
    .run();
}

export function acceptGoalSuggestion(
  db: Db,
  goalId: number,
  requestId: string,
  ownerMemberId: number | null,
  overrides: AcceptSuggestionInput,
  today: string,
) {
  assertGoalOwner(goalRowOrThrow(db, goalId), ownerMemberId);
  const row = suggestRowOrThrow(db, goalId, requestId);
  if (deriveStatus(row) !== "ready") {
    throw AppError.conflict("coach_proposal_not_ready", "The suggestion is not ready to accept.", {
      requestId,
    });
  }
  const proposal = parseResult<StoredSuggestProposal>(row.resultJson);
  const index = overrides.index ?? 0;
  const chosen = proposal?.interventions[index];
  if (!chosen) {
    throw AppError.badRequest("coach_proposal_not_ready", "The chosen suggestion does not exist.", {
      requestId,
      index,
    });
  }
  return db.transaction((tx) => {
    const fresh = suggestRowOrThrow(tx as unknown as Db, goalId, requestId);
    const stored = parseResult<StoredSuggestProposal>(fresh.resultJson)!;
    if (stored.acceptedInterventionId) return getGoal(tx as unknown as Db, goalId, today).interventions.find((i) => i.id === stored.acceptedInterventionId)!;
    const payload = parseResult<StoredSuggestPayload>(fresh.payloadJson);
    const observationPlan = overrides.observationPlan ?? chosen.observationPlan;
    if (!observationPlan) throw AppError.badRequest("coach_proposal_not_ready", "This older proposal needs an explicit evidence plan before acceptance.");
    const clarificationRationale = payload?.clarification ? `\n\n${payload.clarification.question}\n${payload.clarification.answer}` : "";
    const intervention = startIntervention(tx as unknown as Db, goalId, {
      type: overrides.type ?? chosen.type, commitment: overrides.commitment ?? chosen.commitment,
      rationale: (overrides.rationale ?? chosen.rationale) + clarificationRationale,
      startDate: overrides.startDate ?? chosen.startDate, revisitDate: overrides.revisitDate ?? chosen.revisitDate,
      observationPlan, source: "coach",
    }, today);
    const tasks = overrides.tasks ?? chosen.tasks ?? [];
    const result = tasks.length ? backIntervention(tx as unknown as Db, intervention.id, { tasks, expectedRevision: intervention.revision }, today, { actorMemberId: ownerMemberId }) : intervention;
    tx.update(schema.homeAssistantRequests).set({ resultJson: JSON.stringify({ ...stored, acceptedInterventionId: result.id }) }).where(eq(schema.homeAssistantRequests.id, requestId)).run();
    return result;
  });
}

// --- Assess: request / read / analyze / accept ------------------------------

export function requestInterventionAssessment(
  db: Db,
  interventionId: number,
  ownerMemberId: number | null,
  signal?: HomeAssistantRequestSignal,
  rawReflection: { benefit?: "helped" | "not_helped" | "uncertain"; obstacle?: string } = {},
): string {
  const reflection = parseOrThrow(requestAssessmentSchema, rawReflection);
  const integration = readyIntegration(db);
  const intervention = interventionRowOrThrow(db, interventionId);
  const goal = goalRowOrThrow(db, intervention.goalId);
  assertGoalOwner(goal, ownerMemberId);
  if (goal.ownerMemberId === null) {
    throw AppError.conflict(
      "goal_owner_required",
      "The goal needs an owner before it can be assessed.",
      { goalId: goal.id },
    );
  }
  const evidence = buildInterventionEvidence(db, interventionId, { ownerMemberId: goal.ownerMemberId });
  const digest = summarizeAssessDigest(evidence.activity);
  const candidateItemIds = assessCandidateItemIds(digest);
  const payload: StoredAssessPayload = {
    contractVersion: 2, evidence, reflection, expectedRevision: intervention.revision,
    candidateObservationIds: evidence.observations.map((o) => o.id),
    interventionId,
    taskName: TASK_NAME,
    instructions: buildInterventionAssessInstructions({
      goal: { title: goal.title, notes: goal.notes },
      intervention: {
        type: intervention.type,
        commitment: intervention.commitment,
        rationale: intervention.rationale,
        startDate: intervention.startDate,
        revisitDate: intervention.revisitDate,
      },
      digest, evidence, reflection,
      aiContext: getHouseholdAiContext(db),
      backingTaskId: intervention.backingTaskId,
    }),
    windowStart: evidence.window.startDate,
    windowEnd: evidence.window.endDate,
    candidateItemIds,
  };
  return db.transaction((tx) =>
    enqueueHomeAssistantRequest(
      tx,
      { kind: "goal_assess", integrationId: integration.id, payload },
      signal,
    ),
  );
}

function assessRowOrThrow(db: Db, interventionId: number, requestId: string): {
  row: RequestRow;
  payload: StoredAssessPayload;
} {
  const row = db
    .select()
    .from(schema.homeAssistantRequests)
    .where(eq(schema.homeAssistantRequests.id, requestId))
    .get();
  const payload = row ? parseResult<StoredAssessPayload>(row.payloadJson) : null;
  if (!row || row.kind !== "goal_assess" || payload?.interventionId !== interventionId) {
    throw AppError.notFound("coach_request_not_found", "The assessment request was not found.", {
      interventionId,
      requestId,
    });
  }
  return { row, payload };
}

export function getAssessmentProposal(
  db: Db,
  interventionId: number,
  requestId: string,
  ownerMemberId: number | null,
): AssessmentProposal {
  const intervention = interventionRowOrThrow(db, interventionId);
  assertGoalOwner(goalRowOrThrow(db, intervention.goalId), ownerMemberId);
  const { row, payload } = assessRowOrThrow(db, interventionId, requestId);
  const status = deriveStatus(row);
  const proposal = status === "ready" ? parseResult<StoredAssessProposal>(row.resultJson) : null;
  return {
    requestId,
    interventionId,
    status,
    band: proposal?.band ?? null,
    rationaleMd: proposal?.rationaleMd ?? null,
    countedItemIds: proposal?.countedItemIds ?? [],
    countedObservationIds: proposal?.countedObservationIds ?? [],
    reminderEnabled: proposal?.reminderEnabled,
    recommendedDecision: proposal?.recommendedDecision,
    observationPlan: proposal?.observationPlan, commitment: proposal?.commitment, nextRevisitDate: proposal?.nextRevisitDate,
    evidence: payload.evidence,
    windowStart: payload.windowStart,
    windowEnd: payload.windowEnd,
    nextMove: proposal?.nextMove ?? null,
    error: errorMessage(row),
  };
}

/** Owner handler: validate the AI output and store (or fail) the proposal. */
export function onInterventionAssessAnalyzed(db: Db, row: RequestRow, raw: unknown): void {
  const payload = parseResult<StoredAssessPayload>(row.payloadJson);
  const proposal = payload ? validateAssessResponse(raw, payload.candidateItemIds, payload.candidateObservationIds, payload.contractVersion === 2) : null;
  if (!proposal) {
    db.update(schema.homeAssistantRequests)
      .set({
        status: "failed",
        resultJson: null,
        error: JSON.stringify({
          code: "ai_task_invalid_response",
          message: "The AI Task did not return a usable assessment.",
        }),
      })
      .where(eq(schema.homeAssistantRequests.id, row.id))
      .run();
    return;
  }
  db.update(schema.homeAssistantRequests)
    .set({ resultJson: JSON.stringify(proposal) })
    .where(eq(schema.homeAssistantRequests.id, row.id))
    .run();
}

export function acceptAssessmentProposal(
  db: Db,
  interventionId: number,
  requestId: string,
  ownerMemberId: number | null,
  overrides: AcceptAssessmentInput,
) {
  const intervention = interventionRowOrThrow(db, interventionId);
  assertGoalOwner(goalRowOrThrow(db, intervention.goalId), ownerMemberId);
  const { row, payload } = assessRowOrThrow(db, interventionId, requestId);
  if (deriveStatus(row) !== "ready") {
    throw AppError.conflict("coach_proposal_not_ready", "The assessment is not ready to accept.", {
      requestId,
    });
  }
  const proposal = parseResult<StoredAssessProposal>(row.resultJson);
  if (!proposal) {
    throw AppError.conflict("coach_proposal_not_ready", "The assessment is not ready to accept.", {
      requestId,
    });
  }
  // One atomic write: the accepted review becomes a real coach-sourced
  // assessment row through the canonical Phase 1 insert path.
  return insertAssessment(
    db,
    interventionId,
    {
      ...overrides,
      reviewKey: `coach:${requestId}`,
      expectedRevision: overrides.expectedRevision ?? payload.expectedRevision ?? intervention.revision,
      decision: overrides.decision ?? proposal.recommendedDecision ?? "continue",
      reminderEnabled: overrides.reminderEnabled ?? proposal.reminderEnabled,
      benefit: overrides.benefit ?? payload.reflection?.benefit,
      obstacle: overrides.obstacle ?? payload.reflection?.obstacle,
      observationPlan: overrides.observationPlan ?? proposal.observationPlan,
      commitment: overrides.commitment ?? proposal.commitment,
      nextRevisitDate: overrides.nextRevisitDate ?? proposal.nextRevisitDate,
      countedObservationIds: overrides.countedObservationIds ?? proposal.countedObservationIds ?? [],
      evidence: payload.evidence,
      band: overrides.band ?? proposal.band,
      rationaleMd: overrides.rationaleMd ?? proposal.rationaleMd,
      countedItemIds: overrides.countedItemIds ?? proposal.countedItemIds,
      digestWindowStart: payload.windowStart,
      digestWindowEnd: payload.windowEnd,
      assessedAt: overrides.assessedAt,
    },
    "coach",
  );
}
