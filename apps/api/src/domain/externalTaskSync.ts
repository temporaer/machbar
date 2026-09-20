import { and, eq } from "drizzle-orm";
import type { TaskSize } from "@machbar/shared";
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
  priority?: number | null;
  size?: TaskSize | null;
}

/**
 * Notes are intentionally create-time only. Home Assistant must not overwrite
 * arbitrary human-authored notes during later desired-state reconciliation.
 */
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
      });
      tx
        .insert(schema.externalTaskLinks)
        .values({
          source: SOURCE,
          sourceKey: input.sourceKey,
          taskId: task.id,
          state: "active",
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
      if (existing.state !== "active" || existing.withdrawnTaskRevision !== null) {
        tx.update(schema.externalTaskLinks)
          .set({ state: "active", withdrawnTaskRevision: null, updatedAt: nowIso() })
          .where(eq(schema.externalTaskLinks.id, existing.id))
          .run();
      }
      return { taskId: task.id, state: "active" as const };
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
    if (input.person !== undefined) {
      patch.ownerMemberId = personMemberId ?? null;
      patch.ownerInheritanceMode = personMemberId === undefined ? "none" : "explicit";
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
