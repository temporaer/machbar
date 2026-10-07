import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { parseOrThrow } from "../validation.js";
import {
  cleanupAddDoneWhenActionSchema,
  cleanupClarifyAdminActionSchema,
  cleanupCreateTaskActionSchema,
  cleanupRenameActionSchema,
  createCleanupRoundSchema,
} from "../schemas.js";
import { applyCleanupRoundAction, type CleanupRoundAction } from "../cleanupRound/actions.js";
import { HomeAssistantRequestSignal } from "../integrations/homeAssistantRequests.js";
import {
  createCleanupRound,
  dismissCleanupRound,
  getCleanupRound,
  resolveCleanupRoundItem,
  retryCleanupRound,
} from "../cleanupRound/jobs.js";

const ROOT = "/api/cleanup-rounds";

function viewer(request: FastifyRequest): number | null {
  return request.authMember?.id ?? request.activityActor?.id ?? null;
}

function actor(request: FastifyRequest): number | null {
  return request.activityActor?.id ?? null;
}

export function registerCleanupRoundRoutes(
  app: FastifyInstance,
  db: Db,
  signal: HomeAssistantRequestSignal = new HomeAssistantRequestSignal(),
): void {
  app.post(ROOT, async (request, reply) => {
    const body = parseOrThrow(createCleanupRoundSchema, request.body ?? {});
    const id = createCleanupRound(db, signal, {
      scope: body.scope ?? "household",
      actorMemberId: actor(request),
      createdByMemberId: viewer(request),
    });
    reply.status(201);
    return { id };
  });

  app.get<{ Params: { id: string } }>(`${ROOT}/:id`, async (request) =>
    getCleanupRound(db, request.params.id, viewer(request)));

  app.post<{ Params: { id: string } }>(`${ROOT}/:id/retry`, async (request) => {
    retryCleanupRound(db, signal, request.params.id, viewer(request));
    return getCleanupRound(db, request.params.id, viewer(request));
  });

  app.post<{ Params: { id: string } }>(`${ROOT}/:id/dismiss`, async (request) => {
    dismissCleanupRound(db, request.params.id, viewer(request));
    return getCleanupRound(db, request.params.id, viewer(request));
  });

  for (const [segment, resolution] of [
    ["dismiss", "dismissed"],
    ["mark-reviewed", "reviewed"],
  ] as const) {
    app.post<{ Params: { id: string; itemId: string } }>(
      `${ROOT}/:id/items/:itemId/${segment}`,
      async (request) => {
        resolveCleanupRoundItem(db, {
          roundId: request.params.id,
          itemId: request.params.itemId,
          viewerMemberId: viewer(request),
          actorMemberId: actor(request),
          resolution,
        });
        return getCleanupRound(db, request.params.id, viewer(request));
      },
    );
  }

  // Confirmed micro-flows: canonical mutation + card dismissal in one transaction.
  const actions: Array<[string, (body: unknown) => CleanupRoundAction]> = [
    ["rename", (body) => ({ kind: "rename", ...parseOrThrow(cleanupRenameActionSchema, body) })],
    ["create-task", (body) => ({ kind: "createTask", ...parseOrThrow(cleanupCreateTaskActionSchema, body) })],
    ["add-done-when", (body) => ({ kind: "addDoneWhen", ...parseOrThrow(cleanupAddDoneWhenActionSchema, body) })],
    ["clarify-admin", (body) => ({ kind: "clarifyAdmin", ...parseOrThrow(cleanupClarifyAdminActionSchema, body) })],
  ];
  for (const [segment, parse] of actions) {
    app.post<{ Params: { id: string; itemId: string } }>(
      `${ROOT}/:id/items/:itemId/actions/${segment}`,
      async (request) => {
        applyCleanupRoundAction(db, {
          roundId: request.params.id,
          itemId: request.params.itemId,
          viewerMemberId: viewer(request),
          actorMemberId: actor(request),
          action: parse(request.body ?? {}),
        });
        return getCleanupRound(db, request.params.id, viewer(request));
      },
    );
  }
}
