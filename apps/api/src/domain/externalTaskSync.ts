import { and, eq } from "drizzle-orm";
import type { TaskReminderInput, TaskSize } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { createTask, updateTask } from "./taskCrud.js";
import { cancelTask, reopenTask } from "./taskWorkflow.js";

export interface ExternalTaskSyncInput {
  sourceKey: string;
  relevant: boolean;
  title?: string;
  person?: string | null;
  scheduledDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  reactivateCompleted?: boolean;
  overwriteNotes?: boolean;
  deadlineReminder?: {
    daysBefore: number;
    time: string;
    timezone: string;
  } | null;
  priority?: number | null;
  size?: TaskSize | null;
}

const SOURCE = "home_assistant";

// A withdrawn link may reopen only the exact cancellation revision produced by
// Home Assistant. Any human lifecycle change invalidates that authority.
function nowIso(): string {
  return new Date().toISOString();
}

function mappedMemberId(db: Db, integrationId: number, person: string): number {
  const known = db
    .select({ id: schema.homeAssistantPeople.id })
    .from(schema.homeAssistantPeople)
    .where(
      and(
        eq(schema.homeAssistantPeople.integrationId, integrationId),
        eq(schema.homeAssistantPeople.externalId, person),
      ),
    )
    .get();
  const mapping = db
    .select()
    .from(schema.homeAssistantMemberMappings)
    .where(eq(schema.homeAssistantMemberMappings.externalPersonId, person))
    .get();
  if (!known || !mapping) {
    throw AppError.badRequest(
      "identifier_invalid",
      "The Home Assistant person is not mapped to a Machbar member.",
      { person },
    );
  }

  return mapping.memberId;
}

function reminderInput(row: typeof schema.taskReminders.$inferSelect): TaskReminderInput {
  if (row.kind === "absolute") {
    return { id: row.id, kind: "absolute", at: row.at! };
  }
  return {
    id: row.id,
    kind: "deadline_relative",
    daysBefore: row.daysBefore!,
    time: row.time!,
    timezone: row.timezone!,
  };
}

function reconcileManagedReminder(
  db: Db,
  taskId: number,
  managedReminderId: number | null,
  deadlineReminder: NonNullable<ExternalTaskSyncInput["deadlineReminder"]>,
): number | null {
  const current = db
    .select()
    .from(schema.taskReminders)
    .where(eq(schema.taskReminders.taskId, taskId))
    .all();
  const currentIds = new Set(current.map((reminder) => reminder.id));
  const managed = managedReminderId === null
    ? undefined
    : current.find((reminder) => reminder.id === managedReminderId);
  const reminders = current.map(reminderInput);
  if (managed) {
    const index = reminders.findIndex((reminder) => reminder.id === managed.id);
    reminders[index] = {
      id: managed.id,
      kind: "deadline_relative",
      ...deadlineReminder,
    };
  } else {
    reminders.push({ kind: "deadline_relative", ...deadlineReminder });
  }
  updateTask(db, taskId, { reminders });
  if (managed) return managed.id;
  const created = db
    .select({ id: schema.taskReminders.id })
    .from(schema.taskReminders)
    .where(eq(schema.taskReminders.taskId, taskId))
    .all()
    .find((reminder) => !currentIds.has(reminder.id));
  return created?.id ?? null;
}

function removeManagedReminder(
  db: Db,
  taskId: number,
  managedReminderId: number | null,
): number | null {
  if (managedReminderId === null) return null;
  const current = db
    .select()
    .from(schema.taskReminders)
    .where(eq(schema.taskReminders.taskId, taskId))
    .all();
  if (!current.some((reminder) => reminder.id === managedReminderId)) return null;
  updateTask(db, taskId, {
    reminders: current
      .filter((reminder) => reminder.id !== managedReminderId)
      .map(reminderInput),
  });
  return null;
}

export function syncExternalTask(
  db: Db,
  integrationId: number,
  input: ExternalTaskSyncInput,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const existing = tx
      .select()
      .from(schema.externalTaskLinks)
      .where(
        and(
          eq(schema.externalTaskLinks.source, SOURCE),
          eq(schema.externalTaskLinks.sourceKey, input.sourceKey),
        ),
      )
      .get();

    if (!input.relevant) {
      if (!existing) return null;
      const task = tx
        .select({
          status: schema.workItems.status,
          revision: schema.workItems.revision,
        })
        .from(schema.workItems)
        .where(eq(schema.workItems.id, existing.taskId))
        .get();
      if (!task) {
        return {
          taskId: existing.taskId,
          state: "active" as const,
        };
      }
      if (task.status === "done") {
        if (existing.state !== "active" || existing.withdrawnTaskRevision !== null) {
          tx.update(schema.externalTaskLinks)
            .set({ state: "active", withdrawnTaskRevision: null, updatedAt: nowIso() })
            .where(eq(schema.externalTaskLinks.id, existing.id))
            .run();
        }
        return { taskId: existing.taskId, state: "active" as const };
      }
      if (task.status === "cancelled") {
        if (
          existing.state === "withdrawn" &&
          existing.withdrawnTaskRevision === task.revision
        ) {
          return { taskId: existing.taskId, state: "withdrawn" as const };
        }
        if (existing.state !== "active" || existing.withdrawnTaskRevision !== null) {
          tx.update(schema.externalTaskLinks)
            .set({ state: "active", withdrawnTaskRevision: null, updatedAt: nowIso() })
            .where(eq(schema.externalTaskLinks.id, existing.id))
            .run();
        }
        return { taskId: existing.taskId, state: "active" as const };
      }
      const withdrawn = cancelTask(txDb, existing.taskId, "leave_open");
      tx
        .update(schema.externalTaskLinks)
        .set({
          state: "withdrawn",
          withdrawnTaskRevision: withdrawn.revision,
          updatedAt: nowIso(),
        })
        .where(eq(schema.externalTaskLinks.id, existing.id))
        .run();
      return { taskId: existing.taskId, state: "withdrawn" as const };
    }

    if (!existing) {
      if (input.title === undefined) {
        throw AppError.badRequest(
          "external_task_title_required",
          "A title is required when creating a new externally managed task.",
          { sourceKey: input.sourceKey },
        );
      }
      const personMemberId =
        input.person !== undefined && input.person !== null
          ? mappedMemberId(txDb, integrationId, input.person)
          : undefined;
      const task = createTask(txDb, {
        title: input.title,
        notes: input.notes ?? undefined,
        status: "actionable",
        scope: "household",
        ownerMemberId: personMemberId ?? null,
        ownerInheritanceMode:
          input.person === undefined || input.person === null ? "none" : "explicit",
        dueDate: input.dueDate,
        scheduledDate: input.scheduledDate,
        priority: input.priority,
        size: input.size,
        reminders: input.deadlineReminder === undefined || input.deadlineReminder === null
          ? undefined
          : [{ kind: "deadline_relative", ...input.deadlineReminder }],
      });
      const managedReminderId = input.deadlineReminder
        ? task.reminders.find((reminder) => reminder.kind === "deadline_relative")?.id ?? null
        : null;
      tx
        .insert(schema.externalTaskLinks)
        .values({
          source: SOURCE,
          sourceKey: input.sourceKey,
          taskId: task.id,
          state: "active",
          managedReminderId,
        })
        .run();
      return { taskId: task.id, state: "active" as const };
    }

    const task = tx
      .select()
      .from(schema.workItems)
      .where(eq(schema.workItems.id, existing.taskId))
      .get();
    if (!task) throw AppError.notFound("task_not_found", "The linked task was not found.");
    if (task.status === "done") {
      if (input.reactivateCompleted !== true) {
        if (existing.state !== "active" || existing.withdrawnTaskRevision !== null) {
          tx.update(schema.externalTaskLinks)
            .set({ state: "active", withdrawnTaskRevision: null, updatedAt: nowIso() })
            .where(eq(schema.externalTaskLinks.id, existing.id))
            .run();
        }
        return { taskId: task.id, state: "active" as const };
      }
      reopenTask(txDb, task.id);
    }
    if (task.status === "cancelled" && existing.state === "withdrawn") {
      if (existing.withdrawnTaskRevision === task.revision) {
        reopenTask(txDb, task.id);
      } else {
        tx.update(schema.externalTaskLinks)
          .set({
            state: "active",
            withdrawnTaskRevision: null,
            updatedAt: nowIso(),
          })
          .where(eq(schema.externalTaskLinks.id, existing.id))
          .run();
        return { taskId: task.id, state: "active" as const };
      }
    } else if (task.status === "cancelled") {
      return { taskId: task.id, state: "active" as const };
    }

    let personMemberId: number | undefined;
    if (input.person !== undefined && input.person !== null) {
      personMemberId = mappedMemberId(txDb, integrationId, input.person);
    }

    const patch: Parameters<typeof updateTask>[2] = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.scheduledDate !== undefined) patch.scheduledDate = input.scheduledDate;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.size !== undefined) patch.size = input.size;
    if (input.overwriteNotes === true && input.notes !== undefined) {
      patch.notes = input.notes ?? "";
    }
    if (input.person !== undefined) {
      patch.ownerMemberId = personMemberId ?? null;
      patch.ownerInheritanceMode = personMemberId === undefined ? "none" : "explicit";
    }
    if (input.deadlineReminder !== undefined) {
      const managedReminderId = input.deadlineReminder === null
        ? removeManagedReminder(txDb, task.id, existing.managedReminderId)
        : reconcileManagedReminder(
            txDb,
            task.id,
            existing.managedReminderId,
            input.deadlineReminder,
          );
      tx
        .update(schema.externalTaskLinks)
        .set({ managedReminderId, updatedAt: nowIso() })
        .where(eq(schema.externalTaskLinks.id, existing.id))
        .run();
    }
    if (Object.keys(patch).length > 0) updateTask(txDb, task.id, patch);
    tx
      .update(schema.externalTaskLinks)
      .set({ state: "active", withdrawnTaskRevision: null, updatedAt: nowIso() })
      .where(eq(schema.externalTaskLinks.id, existing.id))
      .run();
    return { taskId: task.id, state: "active" as const };
  });
}
