import { and, asc, eq, isNull } from "drizzle-orm";
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

export interface PushSendOptions {
  /** Web Push TTL in seconds — how long the push service should retain an
   * undelivered notification for the browser to pick up. Applied to real
   * notification events (see `dispatchNotificationEvents`), not the
   * interactive test-push send in `routes/push.ts`. */
  ttl?: number;
}

export interface PushTransport {
  send(
    subscription: webpush.PushSubscription,
    payload: string,
    options?: PushSendOptions,
  ): Promise<void>;
}

export interface PushLogger {
  error(message: string, context?: Record<string, unknown>): void;
}

/** Real (non-test) notifications are retained by the push service for up
 * to a week so a temporarily offline device still receives them on
 * reconnect, while very stale reminders are eventually discarded. */
const NOTIFICATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createWebPushTransport(config: VapidConfig): PushTransport {
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return {
    async send(subscription, payload, options) {
      await webpush.sendNotification(
        subscription,
        payload,
        options?.ttl !== undefined ? { TTL: options.ttl } : undefined,
      );
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
      .from(schema.workItems)
      .where(and(eq(schema.workItems.id, event.entityId), eq(schema.workItems.role, "task")))
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
        revision: schema.workItems.revision,
        repeatAfterDays: schema.workItems.repeatAfterDays,
      })
      .from(schema.workItems)
      .where(and(eq(schema.workItems.id, event.entityId), eq(schema.workItems.role, "task")))
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
    if (event.kind === "task_reminder") {
      const task = db
        .select({ status: schema.workItems.status })
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, event.entityId),
            eq(schema.workItems.role, "task"),
          ),
        )
        .get();
      // The task became done/cancelled (or was deleted) after this
      // reminder was enqueued: the reminder is intentionally moot, not a
      // delivery failure, so mark it processed without sending or
      // retrying.
      if (!task || task.status === "done" || task.status === "cancelled") {
        db.update(schema.notificationEvents)
          .set({ processedAt: now.toISOString() })
          .where(eq(schema.notificationEvents.id, event.id))
          .run();
        continue;
      }
    }
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
    // The recipient opted out: also not a delivery failure, so mark
    // processed immediately rather than retrying.
    if (disabled) {
      db.update(schema.notificationEvents)
        .set({ processedAt: now.toISOString() })
        .where(eq(schema.notificationEvents.id, event.id))
        .run();
      continue;
    }
    const subscriptions = db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.memberId, event.recipientMemberId))
      .all();
    const alreadyDelivered = new Set(
      db
        .select({
          subscriptionId: schema.notificationDeliveries.pushSubscriptionId,
        })
        .from(schema.notificationDeliveries)
        .where(eq(schema.notificationDeliveries.notificationEventId, event.id))
        .all()
        .map((row) => row.subscriptionId),
    );
    let hadTransientFailure = false;
    for (const subscription of subscriptions) {
      // Idempotent retry: a subscription that already has a delivery
      // record succeeded on a prior pass and must not be sent to again,
      // even though the event as a whole is still pending because a
      // different subscription is still failing.
      if (alreadyDelivered.has(subscription.id)) continue;
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
          { ttl: NOTIFICATION_TTL_SECONDS },
        );
        db.insert(schema.notificationDeliveries)
          .values({
            notificationEventId: event.id,
            pushSubscriptionId: subscription.id,
            deliveredAt: now.toISOString(),
          })
          .onConflictDoNothing({
            target: [
              schema.notificationDeliveries.notificationEventId,
              schema.notificationDeliveries.pushSubscriptionId,
            ],
          })
          .run();
      } catch (error) {
        const code = webPushStatusCode(error);
        if (code === 404 || code === 410) {
          // Permanently resolved: the subscription is gone, so there is
          // nothing left to retry for it.
          db.delete(schema.pushSubscriptions)
            .where(eq(schema.pushSubscriptions.id, subscription.id))
            .run();
        } else {
          // Transient/network/5xx failure: leave the event unprocessed so
          // a later runner pass retries this subscription (and only this
          // one — see the `alreadyDelivered` check above).
          hadTransientFailure = true;
          logger.error("Web Push delivery failed.", {
            notificationEventId: event.id,
            subscriptionId: subscription.id,
            error,
          });
        }
      }
    }
    if (!hadTransientFailure) {
      db.update(schema.notificationEvents)
        .set({ processedAt: now.toISOString() })
        .where(eq(schema.notificationEvents.id, event.id))
        .run();
    }
  }
  return events.length;
}
