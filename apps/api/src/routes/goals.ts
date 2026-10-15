import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { parseOrThrow } from "../validation.js";
import {
  adjustInterventionSchema,
  createGoalSchema,
  goalLifecycleSchema,
  interventionLifecycleSchema,
  manualAssessmentSchema,
  startInterventionSchema,
  updateGoalSchema,
} from "../schemas.js";
import { householdToday } from "../domain/householdCalendar.js";
import {
  adjustIntervention,
  concludeGoal,
  concludeIntervention,
  createGoal,
  createManualAssessment,
  getGoal,
  listGoals,
  startIntervention,
  updateGoal,
} from "../domain/goals.js";

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

export function registerGoalRoutes(app: FastifyInstance, db: Db): void {
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

  app.post<{ Params: { id: string } }>("/api/interventions/:id/conclude", async (request) => {
    const body = parseOrThrow(interventionLifecycleSchema, request.body ?? {});
    return concludeIntervention(
      db,
      parseId(request.params.id, "intervention"),
      body.expectedRevision,
      householdToday(db),
    );
  });

  app.post<{ Params: { id: string } }>("/api/interventions/:id/assessments", async (request, reply) => {
    const body = parseOrThrow(manualAssessmentSchema, request.body ?? {});
    const assessment = createManualAssessment(db, parseId(request.params.id, "intervention"), body);
    reply.status(201);
    return assessment;
  });
}
