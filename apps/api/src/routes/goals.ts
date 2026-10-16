import { requestAssessmentSchema } from "../schemas.js";
import { requestGoalSuggestionSchema } from "../schemas.js";
import { buildInterventionEvidence } from "../domain/interventionEvidence.js";
import { recentInterventionReports, observationHistory, setObservationPlan, recordObservation } from "../domain/interventionObservations.js";
import { recordObservationSchema, setObservationPlanSchema } from "../schemas.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { parseOrThrow } from "../validation.js";
import {
  acceptAssessmentSchema,
  acceptSuggestionSchema,
  adjustInterventionSchema,
  backInterventionSchema,
  createGoalSchema,
  goalLifecycleSchema,
  interventionLifecycleSchema,
  manualAssessmentSchema,
  startInterventionSchema,
  updateGoalSchema,
} from "../schemas.js";
import { householdToday } from "../domain/householdCalendar.js";
import {
  assertGoalAccessible,
  assertInterventionAccessible,
  adjustIntervention,
  backIntervention,
  concludeGoal,
  concludeIntervention,
  createGoal,
  createManualAssessment,
  getGoal,
  listGoals,
  startIntervention,
  updateGoal,
} from "../domain/goals.js";
import {
  acceptAssessmentProposal,
  acceptGoalSuggestion,
  getAssessmentProposal,
  getGoalSuggestion,
  requestGoalSuggestion,
  requestInterventionAssessment,
} from "../goals/coach.js";
import { HomeAssistantRequestSignal } from "../integrations/homeAssistantRequests.js";

function parseId(raw: string, resource: "goal" | "intervention"): number {
  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest(
      "identifier_invalid",
      `The ${resource} ID must be a number.`,
      { resource, value: raw },
    );
  }
  return id;
}

/** Goals are owner-scoped personal items; the viewer owns and sees its own. */
function viewerMemberId(request: FastifyRequest): number | undefined {
  return request.authMember?.id ?? request.activityActor?.id ?? undefined;
}

export function registerGoalRoutes(
  app: FastifyInstance,
  db: Db,
  signal: HomeAssistantRequestSignal = new HomeAssistantRequestSignal(),
): void {
  app.addHook("preHandler", async (request) => {
    const path = request.routeOptions.url ?? "";
    if (!/^\/api\/(goals|interventions)(?:\/|$)/.test(path)) return;
    const viewer = viewerMemberId(request);
    if (viewer === undefined) {
      throw AppError.unauthorized("authentication_required", "Choose a member before accessing private goals.");
    }
    const id = (request.params as { id?: string }).id;
    if (id !== undefined) {
      const access = { ownerMemberId: viewer };
      if (path.startsWith("/api/goals/")) assertGoalAccessible(db, parseId(id, "goal"), access);
      else assertInterventionAccessible(db, parseId(id, "intervention"), access);
    }
  });

  app.get("/api/goals", async (request) => {
    const viewer = viewerMemberId(request);
    return listGoals(db, viewer === undefined ? {} : { ownerMemberId: viewer }, householdToday(db));
  });

  app.get<{ Params: { id: string } }>("/api/goals/:id", async (request) =>
    getGoal(db, parseId(request.params.id, "goal"), householdToday(db)),
  );

  app.post("/api/goals", async (request, reply) => {
    const body = parseOrThrow(createGoalSchema, request.body ?? {});
    const viewer = viewerMemberId(request);
    if (body.ownerMemberId !== undefined && body.ownerMemberId !== viewer) {
      throw AppError.badRequest("goal_owner_required", "Private goals must belong to the current member.");
    }
    const goal = createGoal(
      db,
      {
        title: body.title,
        notes: body.notes,
        area: body.area,
        ownerMemberId: body.ownerMemberId === undefined ? (viewer ?? null) : body.ownerMemberId,
        createdByMemberId: viewer ?? null,
      },
      householdToday(db),
    );
    reply.status(201);
    return goal;
  });

  app.patch<{ Params: { id: string } }>("/api/goals/:id", async (request) => {
    const body = parseOrThrow(updateGoalSchema, request.body ?? {});
    return updateGoal(db, parseId(request.params.id, "goal"), body, householdToday(db));
  });

  app.post<{ Params: { id: string } }>("/api/goals/:id/conclude", async (request) => {
    const body = parseOrThrow(goalLifecycleSchema, request.body ?? {});
    return concludeGoal(db, parseId(request.params.id, "goal"), body.expectedRevision, householdToday(db));
  });

  app.post<{ Params: { id: string } }>("/api/goals/:id/interventions", async (request, reply) => {
    const body = parseOrThrow(startInterventionSchema, request.body ?? {});
    const intervention = startIntervention(
      db,
      parseId(request.params.id, "goal"),
      { ...body, source: "manual" },
      householdToday(db),
    );
    reply.status(201);
    return intervention;
  });

  app.patch<{ Params: { id: string } }>("/api/interventions/:id", async (request) => {
    const body = parseOrThrow(adjustInterventionSchema, request.body ?? {});
    return adjustIntervention(db, parseId(request.params.id, "intervention"), body, householdToday(db));
  });

  app.post<{ Params: { id: string } }>("/api/interventions/:id/backing", async (request, reply) => {
    const body = parseOrThrow(backInterventionSchema, request.body ?? {});
    const intervention = backIntervention(
      db,
      parseId(request.params.id, "intervention"),
      body,
      householdToday(db),
      { actorMemberId: request.activityActor?.id ?? null },
    );
    reply.status(201);
    return intervention;
  });

  app.post<{ Params: { id: string } }>("/api/interventions/:id/conclude", async (request) => {
    const body = parseOrThrow(interventionLifecycleSchema, request.body ?? {});
    return concludeIntervention(
      db,
      parseId(request.params.id, "intervention"),
      body.expectedRevision,
      householdToday(db),
      {
        backingCleanup: body.backingCleanup,
        context: { actorMemberId: request.activityActor?.id ?? null },
      },
    );
  });

  app.post<{ Params: { id: string } }>("/api/interventions/:id/assessments", async (request, reply) => {
    const body = parseOrThrow(manualAssessmentSchema, request.body ?? {});
    const assessment = createManualAssessment(db, parseId(request.params.id, "intervention"), body);
    reply.status(201);
    return assessment;
  });

  app.get<{ Params: { id: string } }>("/api/interventions/:id/observations", async (request) =>
    ({ ...observationHistory(db, parseId(request.params.id, "intervention"), { ownerMemberId: viewerMemberId(request)! }),
       recentReports: recentInterventionReports(db, parseId(request.params.id, "intervention"), { ownerMemberId: viewerMemberId(request)! }) }));
  app.put<{ Params: { id: string } }>("/api/interventions/:id/observation-plan", async (request) =>
    setObservationPlan(db, parseId(request.params.id, "intervention"), parseOrThrow(setObservationPlanSchema, request.body), { ownerMemberId: viewerMemberId(request)! }));
  app.put<{ Params: { id: string } }>("/api/interventions/:id/observations", async (request) =>
    recordObservation(db, parseId(request.params.id, "intervention"), parseOrThrow(recordObservationSchema, request.body), { ownerMemberId: viewerMemberId(request)! }));

  app.get<{ Params: { id: string }; Querystring: { startDate?: string; endDate?: string } }>("/api/interventions/:id/evidence", async (request) =>
    buildInterventionEvidence(db, parseId(request.params.id, "intervention"), { ownerMemberId: viewerMemberId(request)! }, request.query));

  // --- Coach AI passes (advisory, proposal-not-applied; §7/§9) --------------

  app.post<{ Params: { id: string } }>("/api/goals/:id/suggest", async (request, reply) => {
    const requestId = requestGoalSuggestion(
      db,
      parseId(request.params.id, "goal"),
      viewerMemberId(request) ?? null,
      signal,
      parseOrThrow(requestGoalSuggestionSchema, request.body ?? {}),
    );
    reply.status(202);
    return getGoalSuggestion(db, parseId(request.params.id, "goal"), requestId, viewerMemberId(request) ?? null);
  });

  app.get<{ Params: { id: string; requestId: string } }>(
    "/api/goals/:id/suggest/:requestId",
    async (request) =>
      getGoalSuggestion(
        db,
        parseId(request.params.id, "goal"),
        request.params.requestId,
        viewerMemberId(request) ?? null,
      ),
  );

  app.post<{ Params: { id: string; requestId: string } }>(
    "/api/goals/:id/suggest/:requestId/accept",
    async (request, reply) => {
      const body = parseOrThrow(acceptSuggestionSchema, request.body ?? {});
      const intervention = acceptGoalSuggestion(
        db,
        parseId(request.params.id, "goal"),
        request.params.requestId,
        viewerMemberId(request) ?? null,
        body,
        householdToday(db),
      );
      reply.status(201);
      return intervention;
    },
  );

  app.post<{ Params: { id: string } }>("/api/interventions/:id/assess", async (request, reply) => {
    const requestId = requestInterventionAssessment(
      db,
      parseId(request.params.id, "intervention"),
      viewerMemberId(request) ?? null,
      signal,
      parseOrThrow(requestAssessmentSchema, request.body ?? {}),
    );
    reply.status(202);
    return getAssessmentProposal(
      db,
      parseId(request.params.id, "intervention"),
      requestId,
      viewerMemberId(request) ?? null,
    );
  });

  app.get<{ Params: { id: string; requestId: string } }>(
    "/api/interventions/:id/assess/:requestId",
    async (request) =>
      getAssessmentProposal(
        db,
        parseId(request.params.id, "intervention"),
        request.params.requestId,
        viewerMemberId(request) ?? null,
      ),
  );

  app.post<{ Params: { id: string; requestId: string } }>(
    "/api/interventions/:id/assess/:requestId/accept",
    async (request, reply) => {
      const body = parseOrThrow(acceptAssessmentSchema, request.body ?? {});
      const assessment = acceptAssessmentProposal(
        db,
        parseId(request.params.id, "intervention"),
        request.params.requestId,
        viewerMemberId(request) ?? null,
        body,
      );
      reply.status(201);
      return assessment;
    },
  );
}
