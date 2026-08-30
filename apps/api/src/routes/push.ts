import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { PushConfig } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { AppError } from "../errors.js";
import {
  pushSubscriptionRemovalSchema,
  pushSubscriptionSchema,
} from "../schemas.js";
import { parseOrThrow } from "../validation.js";

function currentMemberId(request: {
  activityActor: { id: number } | null;
}): number {
  if (request.activityActor) return request.activityActor.id;
  throw AppError.badRequest(
    "push_member_required",
    "A current member is required to manage Push notifications.",
  );
}

export function registerPushRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
): void {
  app.get("/api/push/config", async (): Promise<PushConfig> => ({
    enabled: env.push !== null,
    publicKey: env.push?.publicKey ?? null,
  }));

  app.put("/api/push/subscription", async (request, reply) => {
    const memberId = currentMemberId(request);
    const body = parseOrThrow(pushSubscriptionSchema, request.body);
    const now = new Date().toISOString();
    db.insert(schema.pushSubscriptions)
      .values({
        ...body,
        memberId,
        timezone: body.timezone ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.endpoint,
        set: {
          memberId,
          p256dh: body.p256dh,
          auth: body.auth,
          locale: body.locale,
          timezone: body.timezone ?? null,
          updatedAt: now,
        },
      })
      .run();
    reply.status(204);
    return null;
  });

  app.delete("/api/push/subscription", async (request, reply) => {
    const memberId = currentMemberId(request);
    const body = parseOrThrow(pushSubscriptionRemovalSchema, request.body);
    db.delete(schema.pushSubscriptions)
      .where(
        and(
          eq(schema.pushSubscriptions.endpoint, body.endpoint),
          eq(schema.pushSubscriptions.memberId, memberId),
        ),
      )
      .run();
    reply.status(204);
    return null;
  });
}
