import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type {
  PushConfig,
  PushNotificationPreferences,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { AppError } from "../errors.js";
import {
  buildTestNotificationPayload,
  type PushTransport,
  webPushStatusCode,
} from "../notifications/delivery.js";
import {
  pushNotificationPreferencesSchema,
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

const defaultPreferences: PushNotificationPreferences = {
  project_assigned: true,
  task_reminder: true,
  context_entered: true,
};

function getPreferences(
  db: Db,
  memberId: number,
): PushNotificationPreferences {
  const row = db
    .select()
    .from(schema.pushNotificationPreferences)
    .where(eq(schema.pushNotificationPreferences.memberId, memberId))
    .get();
  return row
    ? {
        project_assigned: row.projectAssigned,
        task_reminder: row.taskReminder,
        context_entered: row.contextEntered,
      }
    : defaultPreferences;
}

export function registerPushRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  transport?: PushTransport,
): void {
  app.get("/api/push/config", async (): Promise<PushConfig> => ({
    enabled: env.push !== null,
    publicKey: env.push?.publicKey ?? null,
  }));

  app.get(
    "/api/push/preferences",
    async (request): Promise<PushNotificationPreferences> =>
      getPreferences(db, currentMemberId(request)),
  );

  app.put("/api/push/preferences", async (request) => {
    const memberId = currentMemberId(request);
    const preferences = parseOrThrow(
      pushNotificationPreferencesSchema,
      request.body,
    );
    const values = {
      memberId,
      projectAssigned: preferences.project_assigned,
      taskReminder: preferences.task_reminder,
      contextEntered: preferences.context_entered,
      updatedAt: new Date().toISOString(),
    };
    db.insert(schema.pushNotificationPreferences)
      .values(values)
      .onConflictDoUpdate({
        target: schema.pushNotificationPreferences.memberId,
        set: values,
      })
      .run();
    return preferences;
  });

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

  app.post("/api/push/test", async (request, reply) => {
    const memberId = currentMemberId(request);
    if (!env.push || !transport) {
      throw AppError.badRequest(
        "push_not_configured",
        "Push notifications are not configured.",
      );
    }
    const body = parseOrThrow(pushSubscriptionRemovalSchema, request.body);
    const subscription = db
      .select()
      .from(schema.pushSubscriptions)
      .where(
        and(
          eq(schema.pushSubscriptions.endpoint, body.endpoint),
          eq(schema.pushSubscriptions.memberId, memberId),
        ),
      )
      .get();
    if (!subscription) {
      throw AppError.conflict(
        "push_subscription_missing",
        "This browser subscription is no longer registered.",
      );
    }

    try {
      await transport.send(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        JSON.stringify(
          buildTestNotificationPayload(memberId, subscription.locale),
        ),
      );
    } catch (error) {
      const code = webPushStatusCode(error);
      if (code === 404 || code === 410) {
        db.delete(schema.pushSubscriptions)
          .where(eq(schema.pushSubscriptions.id, subscription.id))
          .run();
        throw AppError.conflict(
          "push_subscription_missing",
          "This browser subscription has expired.",
        );
      }
      throw error;
    }

    reply.status(204);
    return null;
  });
}
