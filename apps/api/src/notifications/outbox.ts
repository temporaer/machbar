import { and, inArray, isNotNull, lte, notInArray } from "drizzle-orm";
import type {
  NotificationEntityType,
  NotificationKind,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { getEffectiveOwners } from "../repo/effectiveRepo.js";

export interface NotificationIntent {
  kind: NotificationKind;
  recipientMemberId: number;
  actorMemberId: number | null;
  entityType: NotificationEntityType;
  entityId: number;
  entityTitle: string;
  sourceKey: string;
}

export function enqueueNotification(
  db: Db,
  intent: NotificationIntent,
): void {
  if (intent.recipientMemberId === intent.actorMemberId) return;
  db.insert(schema.notificationEvents)
    .values(intent)
    .onConflictDoNothing({ target: schema.notificationEvents.sourceKey })
    .run();
}

export function enqueueDueReminders(
  db: Db,
  now = new Date(),
): number {
  const dueTasks = db
    .select()
    .from(schema.tasks)
    .where(
      and(
        isNotNull(schema.tasks.reminderAt),
        lte(schema.tasks.reminderAt, now.toISOString()),
        notInArray(schema.tasks.status, ["done", "cancelled"]),
      ),
    )
    .all();
  if (dueTasks.length === 0) return 0;

  const owners = getEffectiveOwners(db);
  let inserted = 0;
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    for (const task of dueTasks) {
      const recipientMemberId = owners.get(task.id)?.ownerId ?? null;
      if (recipientMemberId === null || task.reminderAt === null) continue;
      const result = txDb
        .insert(schema.notificationEvents)
        .values({
          kind: "task_reminder",
          recipientMemberId,
          actorMemberId: null,
          entityType: "task",
          entityId: task.id,
          entityTitle: task.title,
          sourceKey: `task:${task.id}:reminder:${task.reminderAt}`,
        })
        .onConflictDoNothing({ target: schema.notificationEvents.sourceKey })
        .run();
      inserted += result.changes;
    }
  });
  return inserted;
}

export function hasOpenDescendants(db: Db, taskId: number): boolean {
  const rows = db
    .select({ id: schema.tasks.id, parentTaskId: schema.tasks.parentTaskId })
    .from(schema.tasks)
    .all();
  const descendants = new Set<number>();
  let frontier = [taskId];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    frontier = rows
      .filter(
        (row) =>
          row.parentTaskId !== null &&
          parents.has(row.parentTaskId) &&
          !descendants.has(row.id),
      )
      .map((row) => row.id);
    frontier.forEach((id) => descendants.add(id));
  }
  if (descendants.size === 0) return false;
  return (
    db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          inArray(schema.tasks.id, [...descendants]),
          notInArray(schema.tasks.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}
