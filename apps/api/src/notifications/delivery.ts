import { asc, eq, isNull } from "drizzle-orm";
import type {
  PushNotificationAction,
  PushNotificationPayload,
} from "@machbar/shared";
import webpush from "web-push";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { VapidConfig } from "../env.js";
import { hasOpenDescendants } from "./outbox.js";
import { notificationCatalog } from "./locales.js";

export interface PushTransport {
  send(
    subscription: webpush.PushSubscription,
    payload: string,
  ): Promise<void>;
}

export interface PushLogger {
  error(message: string, context?: Record<string, unknown>): void;
}

export function createWebPushTransport(config: VapidConfig): PushTransport {
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return {
    async send(subscription, payload) {
      await webpush.sendNotification(subscription, payload);
    },
  };
}

function tagFor(
  event: typeof schema.notificationEvents.$inferSelect,
): string {
  if (event.kind === "task_reminder") {
    return event.sourceKey;
  }
  if (event.kind === "context_entered") {
    return `task:${event.entityId}:context`;
  }
  return `${event.entityType}:${event.entityId}:assigned`;
}

export function buildNotificationPayload(
  db: Db,
  event: typeof schema.notificationEvents.$inferSelect,
  locale: typeof schema.pushSubscriptions.$inferSelect.locale,
): PushNotificationPayload {
  const catalog = notificationCatalog(locale);
  const copy = catalog.notifications[event.kind];
  const actorName =
    event.actorMemberId === null
      ? null
      : (db
          .select({ name: schema.members.name })
          .from(schema.members)
          .where(eq(schema.members.id, event.actorMemberId))
          .get()?.name ?? null);
  const actionKinds: PushNotificationAction[] = ["open"];
  let taskRevision: number | undefined;
  let recurringTask: boolean | undefined;

  if (event.kind === "task_reminder") {
    const task = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, event.entityId))
      .get();
    if (
      task &&
      task.status !== "done" &&
      task.status !== "cancelled" &&
      task.repeatAfterDays === null &&
      !hasOpenDescendants(db, task.id)
    ) {
      actionKinds.unshift("complete");
      taskRevision = task.revision;
      recurringTask = false;
    }
  } else if (event.kind === "task_assigned") {
    const task = db
      .select({
        revision: schema.tasks.revision,
        repeatAfterDays: schema.tasks.repeatAfterDays,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, event.entityId))
      .get();
    if (task) {
      taskRevision = task.revision;
      recurringTask = task.repeatAfterDays !== null;
      if (!recurringTask) actionKinds.unshift("today");
    }
  }

  return {
    version: 1,
    kind: event.kind,
    title: copy.title,
    body: copy.body(actorName, event.entityTitle),
    tag: tagFor(event),
    entity: { type: event.entityType, id: event.entityId },
    recipientMemberId: event.recipientMemberId,
    actions: actionKinds.map((action) => ({
      action,
      title: catalog.actions[action],
    })),
    ...(taskRevision !== undefined ? { taskRevision } : {}),
    ...(recurringTask !== undefined ? { recurringTask } : {}),
  };
}

export function buildTestNotificationPayload(
  recipientMemberId: number,
  locale: typeof schema.pushSubscriptions.$inferSelect.locale,
): PushNotificationPayload {
  const copy = notificationCatalog(locale).test;
  return {
    version: 1,
    kind: "test",
    title: copy.title,
    body: copy.body,
    tag: "machbar-push-test",
    entity: null,
    recipientMemberId,
    actions: [],
  };
}

export function webPushStatusCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return null;
}

export async function dispatchNotificationEvents(
  db: Db,
  transport: PushTransport,
  logger: PushLogger,
  now = new Date(),
  limit = 50,
): Promise<number> {
  const events = db
    .select()
    .from(schema.notificationEvents)
    .where(isNull(schema.notificationEvents.processedAt))
    .orderBy(asc(schema.notificationEvents.id))
    .limit(limit)
    .all();

  for (const event of events) {
    const preferences = db
      .select()
      .from(schema.pushNotificationPreferences)
      .where(
        eq(
          schema.pushNotificationPreferences.memberId,
          event.recipientMemberId,
        ),
      )
      .get();
    const disabled =
      (event.kind === "project_assigned" &&
        preferences?.projectAssigned === false) ||
      (event.kind === "task_reminder" &&
        preferences?.taskReminder === false) ||
      (event.kind === "context_entered" &&
        preferences?.contextEntered === false);
    const subscriptions = db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.memberId, event.recipientMemberId))
      .all();
    for (const subscription of disabled ? [] : subscriptions) {
      const payload = buildNotificationPayload(db, event, subscription.locale);
      try {
        await transport.send(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          JSON.stringify(payload),
        );
      } catch (error) {
        const code = webPushStatusCode(error);
        if (code === 404 || code === 410) {
          db.delete(schema.pushSubscriptions)
            .where(eq(schema.pushSubscriptions.id, subscription.id))
            .run();
        } else {
          logger.error("Web Push delivery failed.", {
            notificationEventId: event.id,
            subscriptionId: subscription.id,
            error,
          });
        }
      }
    }
    db.update(schema.notificationEvents)
      .set({ processedAt: now.toISOString() })
      .where(eq(schema.notificationEvents.id, event.id))
      .run();
  }
  return events.length;
}
