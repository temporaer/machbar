import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import {
  applyHomeAssistantSnapshot,
  createHomeAssistantPairingCode,
  homeAssistantStatus,
  pairHomeAssistant,
  revokeHomeAssistant,
  setHomeAssistantMemberMapping,
} from "../integrations/homeAssistant.js";
import {
  homeAssistantMappingSchema,
  homeAssistantPairSchema,
  homeAssistantSnapshotSchema,
} from "../schemas.js";
import { parseOrThrow } from "../validation.js";

const ROOT = "/api/integrations/home-assistant";

export function registerHomeAssistantRoutes(
  app: FastifyInstance,
  db: Db,
): void {
  app.get(`${ROOT}/status`, async () => homeAssistantStatus(db));

  app.post(`${ROOT}/pairing-code`, async (request, reply) => {
    reply.status(201);
    return createHomeAssistantPairingCode(
      db,
      request.authMember?.id ?? request.activityActor?.id ?? null,
    );
  });

  app.post(`${ROOT}/pair`, async (request) => {
    const body = parseOrThrow(homeAssistantPairSchema, request.body);
    return pairHomeAssistant(db, body.pairingCode, body.protocolVersion);
  });

  app.post(`${ROOT}/context`, async (request, reply) => {
    const body = parseOrThrow(homeAssistantSnapshotSchema, request.body);
    applyHomeAssistantSnapshot(
      db,
      request.homeAssistantIntegrationId!,
      body,
    );
    reply.status(204);
    return null;
  });

  app.put<{ Params: { externalId: string } }>(
    `${ROOT}/people/:externalId/mapping`,
    async (request, reply) => {
      const body = parseOrThrow(homeAssistantMappingSchema, request.body);
      setHomeAssistantMemberMapping(
        db,
        decodeURIComponent(request.params.externalId),
        body.memberId,
      );
      reply.status(204);
      return null;
    },
  );

  app.delete(`${ROOT}/connection`, async (_request, reply) => {
    revokeHomeAssistant(db);
    reply.status(204);
    return null;
  });
}
