import type { FastifyInstance } from "fastify";
import type { HomeAssistantContextSnapshot } from "@machbar/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  applyHomeAssistantSnapshot,
  createHomeAssistantPairingCode,
  homeAssistantStatus,
  pairHomeAssistant,
  revokeHomeAssistant,
  setHomeAssistantMemberMapping,
  activeHomeAssistantIntegration,
} from "../integrations/homeAssistant.js";
import {
  completeHomeAssistantRequest,
  HomeAssistantRequestSignal,
  leaseNextHomeAssistantRequest,
  waitForHomeAssistantRequest,
} from "../integrations/homeAssistantRequests.js";
import { readAttachmentStream } from "../intake/storage.js";
import { syncExternalTask } from "../domain/externalTaskSync.js";
import {
  homeAssistantMappingSchema,
  homeAssistantPairSchema,
  homeAssistantSnapshotSchema,
  homeAssistantSyncTaskSchema,
  homeAssistantCalendarEventRefSchema,
  homeAssistantRequestCompletionSchema,
} from "../schemas.js";
import { parseOrThrow } from "../validation.js";

const ROOT = "/api/integrations/home-assistant";

export function registerHomeAssistantRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  signal = new HomeAssistantRequestSignal(),
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
    if (body.protocolVersion !== 2) {
      throw AppError.badRequest("unsupported_protocol_version", "The Home Assistant protocol version is not supported.");
    }
    applyHomeAssistantSnapshot(
      db,
      request.homeAssistantIntegrationId!,
      body as HomeAssistantContextSnapshot,
    );
    reply.status(204);
    return null;
  });

  app.post(`${ROOT}/tasks/sync`, async (request) => {
    const body = parseOrThrow(homeAssistantSyncTaskSchema, request.body);
    return syncExternalTask(db, request.homeAssistantIntegrationId!, body);
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

  app.get<{ Querystring: { protocolVersion?: string; waitSeconds?: string } }>(
    `${ROOT}/requests/next`,
    async (request, reply) => {
      const protocolVersion = Number(request.query.protocolVersion);
      if (protocolVersion !== 2) {
        throw AppError.badRequest("unsupported_protocol_version", "The Home Assistant protocol version is not supported.");
      }
      const integration = activeHomeAssistantIntegration(db);
      if (!integration || integration.id !== request.homeAssistantIntegrationId) {
        reply.status(401);
        return null;
      }
      const now = new Date().toISOString();
      db.update(schema.homeAssistantIntegrations)
        .set({ lastRequestPollAt: now, protocolVersion: 2 })
        .where(eq(schema.homeAssistantIntegrations.id, integration.id))
        .run();
      const seconds = Math.min(25, Math.max(0, Number(request.query.waitSeconds ?? 25) || 0));
      const abort = new AbortController();
      request.raw.once("close", () => abort.abort());
      const leased = seconds === 0
        ? leaseNextHomeAssistantRequest(db, integration.id)
        : await waitForHomeAssistantRequest(db, signal, integration.id, seconds * 1000, abort.signal);
      if (!leased) {
        reply.status(204);
        return null;
      }
      return leased;
    },
  );

  app.post<{ Params: { id: string } }>(`${ROOT}/requests/:id/complete`, async (request, reply) => {
    const body = parseOrThrow(homeAssistantRequestCompletionSchema, request.body);
    if (body.outcome === "succeeded") {
      const row = db.select().from(schema.homeAssistantRequests)
        .where(eq(schema.homeAssistantRequests.id, request.params.id)).get();
      if (!row) throw AppError.notFound("home_assistant_request_not_found", "The Home Assistant request was not found.");
      const result = row.kind === "intake_analyze"
        ? body.result
        : parseOrThrow(homeAssistantCalendarEventRefSchema, body.result);
      completeHomeAssistantRequest(db, request.homeAssistantIntegrationId!, request.params.id, { ...body, result } as never);
    } else {
      completeHomeAssistantRequest(db, request.homeAssistantIntegrationId!, request.params.id, body as never);
    }
    reply.status(204);
    return null;
  });

  app.get<{ Params: { jobId: string; attachmentId: string } }>(
    `${ROOT}/intake/:jobId/attachments/:attachmentId`,
    async (request, reply) => {
      const integrationId = request.homeAssistantIntegrationId!;
      const row = db.select().from(schema.intakeAttachments)
        .where(eq(schema.intakeAttachments.id, request.params.attachmentId)).get();
      if (!row || row.intakeJobId !== request.params.jobId) {
        reply.status(404);
        return null;
      }
      const leased = db.select().from(schema.homeAssistantRequests)
        .where(and(
          eq(schema.homeAssistantRequests.integrationId, integrationId),
          eq(schema.homeAssistantRequests.intakeJobId, request.params.jobId),
          eq(schema.homeAssistantRequests.kind, "intake_analyze"),
          eq(schema.homeAssistantRequests.status, "leased"),
        )).get();
      if (!leased) {
        reply.status(404);
        return null;
      }
      try {
        const file = readAttachmentStream(env, request.params.jobId, request.params.attachmentId);
        reply.header("content-type", row.mimeType).header("cache-control", "no-store");
        return reply.send(file);
      } catch {
        reply.status(404);
        return null;
      }
    },
  );
}
