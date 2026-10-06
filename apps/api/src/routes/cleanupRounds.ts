import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { parseOrThrow } from "../validation.js";
import { createCleanupRoundSchema } from "../schemas.js";
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
}
