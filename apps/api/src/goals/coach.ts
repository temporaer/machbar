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
  AssessmentBand,
  AssessmentProposal,
  CoachRequestStatus,
  GoalArea,
  GoalSuggestAiResponse,
  GoalAssessAiResponse,
  GoalSuggestionProposal,
  InterventionType,
  ProposedIntervention,
  ReflectionBriefingScope,
} from "@machbar/shared";
import { assessmentBands, interventionTypes } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { getHouseholdAiContext } from "../aiContext.js";
import { householdToday } from "../domain/householdCalendar.js";
import { isIsoCalendarDate, addCalendarDays } from "../domain/calendarDate.js";
import { insertAssessment, startIntervention } from "../domain/goals.js";
import { buildReflectionBriefing } from "../reflection/briefing.js";
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
  goalId: number;
  taskName: typeof TASK_NAME;
  instructions: string;
}

interface StoredAssessPayload {
  interventionId: number;
  taskName: typeof TASK_NAME;
  instructions: string;
  windowStart: string;
  windowEnd: string;
  candidateItemIds: number[];
}

/** Normalized, validated proposals stored on the request row's `resultJson`. */
interface StoredSuggestProposal {
  interventions: ProposedIntervention[];
}
interface StoredAssessProposal {
  band: AssessmentBand;
  rationaleMd: string;
  countedItemIds: number[];
  nextMove: string | null;
}

/** Overrides a user may apply when accepting a suggested intervention. */
export interface AcceptSuggestionInput {
  index?: number;
  type?: InterventionType;
  commitment?: string;
  rationale?: string;
  startDate?: string;
  revisitDate?: string;
}

/** Overrides a user may apply when accepting an assessment proposal. */
export interface AcceptAssessmentInput {
  band?: AssessmentBand;
  rationaleMd?: string;
  countedItemIds?: number[];
  assessedAt?: string;
}

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
  if (ownerMemberId !== null && goal.ownerMemberId !== ownerMemberId) {
    throw AppError.notFound("goal_not_found", "The goal was not found.", { goalId: goal.id });
  }
}

function areaScope(area: GoalArea): ReflectionBriefingScope {
  return area === "work" ? "work" : "all";
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

function validateSuggestResponse(raw: unknown, today: string): StoredSuggestProposal | null {
  const response = raw as GoalSuggestAiResponse | null | undefined;
  if (!response || !Array.isArray(response.interventions)) return null;
  const interventions: ProposedIntervention[] = [];
  for (const entry of response.interventions.slice(0, 2)) {
    if (!entry || typeof entry !== "object") continue;
    const type = entry.type as InterventionType;
    if (!interventionTypes.includes(type)) continue;
    const commitment = typeof entry.commitment === "string" ? entry.commitment.trim() : "";
    if (commitment.length === 0) continue;
    const rationale = typeof entry.rationale === "string" ? entry.rationale.trim() : "";
    const startDate = isIsoCalendarDate(entry.startDate) ? entry.startDate : today;
    const proposedRevisit = isIsoCalendarDate(entry.revisitDate) ? entry.revisitDate : null;
    const revisitDate =
      proposedRevisit && proposedRevisit >= startDate
        ? proposedRevisit
        : addCalendarDays(startDate, DEFAULT_DURATION_DAYS);
    interventions.push({ type, commitment, rationale, startDate, revisitDate });
  }
  return interventions.length > 0 ? { interventions } : null;
}

function validateAssessResponse(
  raw: unknown,
  candidateItemIds: number[],
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
  return { band, rationaleMd, countedItemIds, nextMove };
}

// --- Suggest: request / read / analyze / accept -----------------------------

export function requestGoalSuggestion(
  db: Db,
  goalId: number,
  ownerMemberId: number | null,
  signal?: HomeAssistantRequestSignal,
): string {
  const integration = readyIntegration(db);
  const goal = goalRowOrThrow(db, goalId);
  assertGoalOwner(goal, ownerMemberId);
  const today = householdToday(db);
  const payload: StoredSuggestPayload = {
    goalId,
    taskName: TASK_NAME,
    instructions: buildGoalSuggestInstructions({
      goal: { title: goal.title, notes: goal.notes, area: goal.area },
      today,
      defaultRevisitDate: addCalendarDays(today, DEFAULT_DURATION_DAYS),
      aiContext: getHouseholdAiContext(db),
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
    interventions: proposal?.interventions ?? [],
    error: errorMessage(row),
  };
}

/** Owner handler: validate the AI output and store (or fail) the proposal. */
export function onGoalSuggestAnalyzed(db: Db, row: RequestRow, raw: unknown): void {
  const today = householdToday(db);
  const proposal = validateSuggestResponse(raw, today);
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
  // One atomic write: the accepted proposal becomes a real coach-sourced
  // intervention via the canonical Phase 1 domain path.
  return startIntervention(
    db,
    goalId,
    {
      type: overrides.type ?? chosen.type,
      commitment: overrides.commitment ?? chosen.commitment,
      rationale: overrides.rationale ?? chosen.rationale,
      startDate: overrides.startDate ?? chosen.startDate,
      revisitDate: overrides.revisitDate ?? chosen.revisitDate,
      source: "coach",
    },
    today,
  );
}

// --- Assess: request / read / analyze / accept ------------------------------

export function requestInterventionAssessment(
  db: Db,
  interventionId: number,
  ownerMemberId: number | null,
  signal?: HomeAssistantRequestSignal,
): string {
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
  // Reuse the reflection digest over the intervention's own period (§7.3): the
  // start_date → revisit_date window, one canonical completion/admin/recurring
  // split, no new activity reader.
  const briefing = buildReflectionBriefing(db, {
    subjectMemberId: goal.ownerMemberId,
    days: DEFAULT_DURATION_DAYS,
    scope: areaScope(goal.area),
    window: { startDate: intervention.startDate, endDate: intervention.revisitDate },
  });
  const digest = summarizeAssessDigest(briefing);
  const candidateItemIds = assessCandidateItemIds(digest);
  const payload: StoredAssessPayload = {
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
      digest,
      aiContext: getHouseholdAiContext(db),
    }),
    windowStart: intervention.startDate,
    windowEnd: intervention.revisitDate,
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
    windowStart: payload.windowStart,
    windowEnd: payload.windowEnd,
    nextMove: proposal?.nextMove ?? null,
    error: errorMessage(row),
  };
}

/** Owner handler: validate the AI output and store (or fail) the proposal. */
export function onInterventionAssessAnalyzed(db: Db, row: RequestRow, raw: unknown): void {
  const payload = parseResult<StoredAssessPayload>(row.payloadJson);
  const proposal = payload ? validateAssessResponse(raw, payload.candidateItemIds) : null;
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
