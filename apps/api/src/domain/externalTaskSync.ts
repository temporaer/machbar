import { and, asc, eq } from "drizzle-orm";
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
  revisitAt?: string | null;
  /** @deprecated Use revisitAt. */
  notBeforeAt?: string | null;
  /** @deprecated Use revisitAt. */
  notBeforeDate?: string | null;
  notes?: string | null;
  reactivateCompleted?: boolean;
  overwriteNotes?: boolean;
  deadlineReminder?: {
    daysBefore: number;
    time: string;
    timezone: string;
  } | null;
  deadlineReminders?: Array<{
    key: string;
    daysBefore: number;
    time: string;
    timezone: string;
  }> | null;
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

type ManagedDeadlineReminder = {
  key: string;
  daysBefore: number;
  time: string;
  timezone: string;
};

function managedReminderRequest(
  input: ExternalTaskSyncInput,
): { mode: "all" | "default"; reminders: ManagedDeadlineReminder[] } | undefined {
  if (input.deadlineReminders !== undefined) {
    return {
      mode: "all",
      reminders: input.deadlineReminders ?? [],
    };
  }
  if (input.deadlineReminder !== undefined) {
    return {
      mode: "default",
      reminders: input.deadlineReminder === null
        ? []
        : [{ key: "default", ...input.deadlineReminder }],
    };
  }
  return undefined;
}

function reconcileManagedReminders(
  db: Db,
  taskId: number,
  externalTaskLinkId: number,
  request: { mode: "all" | "default"; reminders: ManagedDeadlineReminder[] },
): void {
  const current = db
    .select()
    .from(schema.taskReminders)
    .where(eq(schema.taskReminders.taskId, taskId))
    .all();
  const currentIds = new Set(current.map((reminder) => reminder.id));
  const mappings = db
    .select()
    .from(schema.externalTaskLinkManagedReminders)
    .where(eq(
      schema.externalTaskLinkManagedReminders.externalTaskLinkId,
      externalTaskLinkId,
    ))
    .all()
    .filter((mapping) => currentIds.has(mapping.reminderId));
  const managedByKey = new Map(mappings.map((mapping) => [mapping.key, mapping]));
  const managedIds = new Set(mappings.map((mapping) => mapping.reminderId));
  const manualReminders = current
    .filter((reminder) => !managedIds.has(reminder.id))
    .map(reminderInput);
  const requested = request.mode === "all"
    ? request.reminders
    : request.reminders;
  const preservedNonDefault = mappings
    .filter((mapping) => mapping.key !== "default")
    .map((mapping) => ({
      key: mapping.key,
      input: reminderInput(current.find((row) => row.id === mapping.reminderId)!),
    }));
  const managedReminders = request.mode === "all"
    ? requested.map((reminder) => {
        const mapping = managedByKey.get(reminder.key);
        return {
          key: reminder.key,
          input: {
            id: mapping?.reminderId,
            kind: "deadline_relative" as const,
            daysBefore: reminder.daysBefore,
            time: reminder.time,
            timezone: reminder.timezone,
          },
        };
      })
    : [
        ...preservedNonDefault,
        ...requested.map((reminder) => ({
          key: reminder.key,
          input: {
            id: managedByKey.get(reminder.key)?.reminderId,
            kind: "deadline_relative" as const,
            daysBefore: reminder.daysBefore,
            time: reminder.time,
            timezone: reminder.timezone,
          },
        })),
      ];
  const next = [
    ...manualReminders,
    ...managedReminders.map(({ input }) => input),
  ];
  updateTask(db, taskId, { reminders: next });
  const newReminderIds = db
    .select({ id: schema.taskReminders.id })
    .from(schema.taskReminders)
    .where(eq(schema.taskReminders.taskId, taskId))
    .orderBy(asc(schema.taskReminders.id))
    .all()
    .map(({ id }) => id)
    .filter((id) => !currentIds.has(id));
  const newKeys = managedReminders
    .filter(({ input }) => input.id === undefined)
    .map(({ key }) => key);
  if (newReminderIds.length !== newKeys.length) {
    throw AppError.badRequest(
      "task_reminder_invalid",
      "The managed reminder IDs could not be reconciled.",
      { taskId, newKeys, newReminderIds },
    );
  }
  const insertedIds = new Map(newKeys.map((key, index) => [key, newReminderIds[index]!]));
  const resolvedMappings = managedReminders.map(({ key, input }) => {
    return {
      externalTaskLinkId,
      key,
      reminderId: input.id ?? insertedIds.get(key)!,
    };
  });
  db.delete(schema.externalTaskLinkManagedReminders)
    .where(eq(
      schema.externalTaskLinkManagedReminders.externalTaskLinkId,
      externalTaskLinkId,
    ))
    .run();
  if (resolvedMappings.length > 0) {
    db.insert(schema.externalTaskLinkManagedReminders)
      .values(resolvedMappings)
      .run();
  }
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
        revisitAt: input.revisitAt ?? input.notBeforeAt ?? null,
        priority: input.priority,
        size: input.size,
        reminders: managedReminderRequest(input)?.reminders.map((reminder) => ({
          kind: "deadline_relative",
          daysBefore: reminder.daysBefore,
          time: reminder.time,
          timezone: reminder.timezone,
        })),
      });
      const link = tx
        .insert(schema.externalTaskLinks)
        .values({
          source: SOURCE,
          sourceKey: input.sourceKey,
          taskId: task.id,
          state: "active",
        })
        .returning()
        .get();
      const requested = managedReminderRequest(input);
      if (requested && requested.reminders.length > 0) {
        const reminderRows = tx
          .select({ id: schema.taskReminders.id })
          .from(schema.taskReminders)
          .where(eq(schema.taskReminders.taskId, task.id))
          .orderBy(asc(schema.taskReminders.id))
          .all();
        const newKeys = requested.reminders.map(({ key }) => key);
        if (reminderRows.length !== newKeys.length) {
          throw AppError.badRequest(
            "task_reminder_invalid",
            "The managed reminder IDs could not be reconciled.",
            { taskId: task.id, newKeys, reminderRows },
          );
        }
        tx.insert(schema.externalTaskLinkManagedReminders)
          .values(newKeys.map((key, index) => ({
            externalTaskLinkId: link.id,
            key,
            reminderId: reminderRows[index]!.id,
          })))
          .run();
      }
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
    if (input.revisitAt !== undefined || input.notBeforeAt !== undefined) {
      patch.revisitAt = input.revisitAt ?? input.notBeforeAt ?? null;
    }
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.size !== undefined) patch.size = input.size;
    if (input.overwriteNotes === true && input.notes !== undefined) {
      patch.notes = input.notes ?? "";
    }
    if (input.person !== undefined) {
      patch.ownerMemberId = personMemberId ?? null;
      patch.ownerInheritanceMode = personMemberId === undefined ? "none" : "explicit";
    }
    const reminderRequest = managedReminderRequest(input);
    if (reminderRequest) {
      reconcileManagedReminders(txDb, task.id, existing.id, reminderRequest);
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
