import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type {
  NotificationEntityType,
  NotificationKind,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { addCalendarDays } from "../domain/calendarDate.js";
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

/**
 * The task's `now` instant expressed as a local `YYYY-MM-DD` calendar date
 * and `HH:mm` wall-clock time in `timeZone` — used to evaluate
 * `deadline_relative` reminders against local time, not UTC/server time,
 * so DST behaves the way a human reading a wall clock in that zone would
 * expect (see `enqueueDueReminders`).
 */
function localDateAndTime(
  instant: Date,
  timeZone: string,
): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function isReminderDue(
  reminder: typeof schema.taskReminders.$inferSelect,
  task: { dueDate: string | null },
  now: Date,
): boolean {
  if (reminder.kind === "absolute") {
    return reminder.at !== null && reminder.at <= now.toISOString();
  }
  // deadline_relative: dormant until the task has a deadline; reactivates
  // and repositions automatically whenever the deadline is set/changed,
  // since the occurrence is always recomputed here rather than stored.
  if (task.dueDate === null) return false;
  const targetDate = addCalendarDays(task.dueDate, -reminder.daysBefore!);
  const local = localDateAndTime(now, reminder.timezone!);
  return `${local.date}T${local.time}` >= `${targetDate}T${reminder.time}`;
}

function reminderOccurrenceKey(
  reminder: typeof schema.taskReminders.$inferSelect,
  task: { dueDate: string | null },
): string {
  if (reminder.kind === "absolute") {
    return `${reminder.id}:${reminder.at}`;
  }
  return `${reminder.id}:deadline:${task.dueDate}:${reminder.daysBefore}:${reminder.time}:${reminder.timezone}`;
}

/**
 * Finds every `task_reminders` row that is currently due (see
 * `isReminderDue`) on an open task and enqueues one `notification_events`
 * row per recipient. A task with an effective owner notifies that member;
 * an ownerless task is **Gemeinsam** (shared), not unowned, so it
 * notifies every member instead of being silently skipped. Reminder rows
 * themselves stay recipient-agnostic — recipients are resolved fresh on
 * every call, so a later ownership change is reflected the next time this
 * runs (see `deletePendingTaskReminderEvents`, called from `taskCrud.ts`
 * whenever effective ownership or the reminder set itself changes, to
 * clear any now-stale pending event so this function's next pass can
 * re-resolve it).
 */
export function enqueueDueReminders(
  db: Db,
  now = new Date(),
): number {
  const reminders = db.select().from(schema.taskReminders).all();
  if (reminders.length === 0) return 0;

  const taskIds = [...new Set(reminders.map((reminder) => reminder.taskId))];
  const tasks = db
    .select({
      id: schema.workItems.id,
      title: schema.workItems.title,
      dueDate: schema.workItems.dueDate,
    })
    .from(schema.workItems)
    .where(
      and(
        eq(schema.workItems.role, "task"),
        inArray(schema.workItems.id, taskIds),
        notInArray(schema.workItems.status, ["done", "cancelled"]),
      ),
    )
    .all();
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  const dueReminders = reminders
    .map((reminder) => ({ reminder, task: tasksById.get(reminder.taskId) }))
    .filter(
      (
        entry,
      ): entry is {
        reminder: (typeof reminders)[number];
        task: NonNullable<(typeof entry)["task"]>;
      } => entry.task !== undefined && isReminderDue(entry.reminder, entry.task, now),
    );
  if (dueReminders.length === 0) return 0;

  const owners = getEffectiveOwners(db);
  const allMemberIds = db
    .select({ id: schema.members.id })
    .from(schema.members)
    .all()
    .map((member) => member.id);

  let inserted = 0;
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    for (const { reminder, task } of dueReminders) {
      const ownerId = owners.get(task.id)?.ownerId ?? null;
      const recipientIds = ownerId !== null ? [ownerId] : allMemberIds;
      const occurrenceKey = reminderOccurrenceKey(reminder, task);
      for (const recipientMemberId of recipientIds) {
        const result = txDb
          .insert(schema.notificationEvents)
          .values({
            kind: "task_reminder",
            recipientMemberId,
            actorMemberId: null,
            entityType: "task",
            entityId: task.id,
            entityTitle: task.title,
            sourceKey: `task:${task.id}:reminder:${occurrenceKey}:member:${recipientMemberId}`,
          })
          .onConflictDoNothing({ target: schema.notificationEvents.sourceKey })
          .run();
        inserted += result.changes;
      }
    }
  });
  return inserted;
}

/**
 * Deletes still-unprocessed `task_reminder` events for a task. Called
 * whenever the task's reminders are edited/deleted or its effective
 * ownership changes, so a stale pending event (wrong occurrence, wrong
 * recipient set) cannot fire — the next `enqueueDueReminders` pass
 * re-resolves it from the current reminder/ownership state. Already
 * `processedAt`-stamped events (delivered, or intentionally skipped) are
 * left alone: they are dedup/history state, not pending work.
 */
export function deletePendingTaskReminderEvents(db: Db, taskId: number): void {
  db.delete(schema.notificationEvents)
    .where(
      and(
        eq(schema.notificationEvents.kind, "task_reminder"),
        eq(schema.notificationEvents.entityType, "task"),
        eq(schema.notificationEvents.entityId, taskId),
        isNull(schema.notificationEvents.processedAt),
      ),
    )
    .run();
}

export function hasOpenDescendants(db: Db, taskId: number): boolean {
  const rows = db
  .select({ id: schema.workItems.id, parentTaskId: schema.workItems.parentId })
  .from(schema.workItems)
  .where(eq(schema.workItems.role, "task"))
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
      .select({ id: schema.workItems.id })
      .from(schema.workItems)
      .where(
        and(
          inArray(schema.workItems.id, [...descendants]),
          notInArray(schema.workItems.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

