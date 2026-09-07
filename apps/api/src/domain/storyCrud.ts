/**
 * Story ("project") CRUD: create/update/delete and free-text notes.
 * Lifecycle transitions live in `storyWorkflow.ts`; acceptance criteria live
 * in `storyCapabilities.ts`.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ProjectStatus } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  neutralizeContribution,
  neutralizeEntityContributions,
  recordActivity,
  recordContribution,
} from "../repo/index.js";
import {
  MutationContext,
  actor,
  appendNoteContent,
  assertExpectedRevision,
  assertPhysicalContextsExist,
  assertProjectActivationReady,
  enqueueProjectAssignment,
  nowIso,
  sameIds,
  sortedIds,
  touchProject,
} from "./workItemShared.js";

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function projectStatusToStored(status: ProjectStatus): "backlog" | "active" | "done" {
  switch (status) {
    case "backlog":
    case "active":
      return status;
    case "completed":
      return "done";
    case "archived":
      return "backlog";
  }
}

function projectStatusFromStored(
  status: string,
  archivedAt: string | null,
): ProjectStatus {
  if (archivedAt !== null) return "archived";
  switch (status) {
    case "active":
      return "active";
    case "done":
      return "completed";
    case "backlog":
    default:
      return "backlog";
  }
}

export interface CreateProjectInput {
  title: string;
  notes?: string;
  parentId?: number | null;
  status?: ProjectStatus;
  ownerMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  tagIds?: number[];
  contextIds?: number[];
}

export function getProjectOrThrow(db: Db, id: number) {
  const project = db
    .select()
    .from(schema.workItems)
    .where(and(eq(schema.workItems.id, id), eq(schema.workItems.role, "story")))
    .get();
  if (!project) {
    throw AppError.notFound(
      "project_not_found",
      "The requested project was not found.",
      { projectId: id },
    );
  }
  return {
    ...project,
    status: projectStatusFromStored(project.status, project.archivedAt),
  };
}

/**
 * New stories default to `backlog`. Direct `active` creation goes through
 * the same readiness invariant as {@link activateProject}; because this
 * command creates no tasks, an unready active request is rolled back.
 */
export function createProject(
  db: Db,
  input: CreateProjectInput,
  context?: MutationContext,
) {
  if (!input.title || input.title.trim() === "") {
    throw AppError.badRequest(
      "project_title_required",
      "The project title must not be empty.",
    );
  }
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const parentId = input.parentId ?? null;
    if (parentId !== null) getProjectOrThrow(txDb, parentId);
    const maxPosition = tx
      .select({ position: schema.workItems.position })
      .from(schema.workItems)
      .where(
        and(
          eq(schema.workItems.role, "story"),
          parentId === null
            ? isNull(schema.workItems.parentId)
            : eq(schema.workItems.parentId, parentId),
        ),
      )
      .all()
      .reduce((max, p) => Math.max(max, p.position), -1);

    const project = tx
      .insert(schema.workItems)
      .values({
        role: "story",
        parentId,
        title: input.title.trim(),
        notes: input.notes ?? "",
        status: projectStatusToStored(input.status ?? "backlog"),
        archivedAt: input.status === "archived" ? nowIso() : null,
        ownerMemberId: input.ownerMemberId ?? null,
        dueDate: input.dueDate ?? null,
        scheduledDate: input.scheduledDate ?? null,
        position: maxPosition + 1,
      })
      .returning()
      .get();

    if (input.tagIds && input.tagIds.length > 0) {
      for (const tagId of input.tagIds) {
        tx.insert(schema.workItemTags)
          .values({ workItemId: project.id, tagId })
          .run();
      }
    }
    const contextIds = sortedIds(input.contextIds ?? []);
    assertPhysicalContextsExist(tx as unknown as Db, contextIds);
    for (const contextId of contextIds) {
      tx.insert(schema.workItemPhysicalContexts)
        .values({ workItemId: project.id, contextId })
        .run();
    }
    const returned = {
      ...project,
      status: projectStatusFromStored(project.status, project.archivedAt),
    };
    if (returned.status === "active") {
      assertProjectActivationReady(txDb, project.id, project.ownerMemberId);
    }
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_created",
      entityType: "project",
      entityTitle: returned.title,
      projectId: project.id,
      metadata: {},
    });
    enqueueProjectAssignment(
      txDb,
      returned,
      activityEventId,
      context,
    );
    return returned;
  });
}

export interface UpdateProjectInput {
  title?: string;
  notes?: string;
  ownerMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  position?: number;
  tagIds?: number[];
  contextIds?: number[];
  expectedRevision?: number;
}

/**
 * Editable project/story metadata: title, driver (`ownerMemberId`),
 * due/scheduled dates and tags. Status transitions are
 * deliberately **not** accepted here — they only ever happen through the
 * explicit {@link activateProject}/{@link returnProjectToBacklog}/
 * {@link completeProject}/{@link reopenProject}/{@link archiveProject}
 * operations below, so every workflow invariant is enforced in exactly one
 * place.
 *
 * A story's driver can never be cleared (`ownerMemberId: null`) while it is
 * `active`/`completed`/`archived` — an `active`/`completed` story must
 * always retain its driver, and clearing it requires first sending the
 * story back to `backlog`.
 */
export function updateProject(
  db: Db,
  id: number,
  input: UpdateProjectInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertExpectedRevision("project", id, project.revision, input.expectedRevision);
    if (input.title !== undefined && input.title.trim() === "") {
      throw AppError.badRequest(
        "project_title_required",
        "The project title must not be empty.",
        { projectId: id },
      );
    }
    if (input.ownerMemberId === null && project.status !== "backlog") {
      throw AppError.conflict(
        "project_driver_locked",
        "The project driver can only be removed while the project is in the backlog.",
        { projectId: id, currentStatus: project.status, requiredStatus: "backlog" },
      );
    }
    const patch: Partial<typeof schema.workItems.$inferInsert> = {};
    const changedFields: string[] = [];
    const title = input.title?.trim();
    if (title !== undefined && title !== project.title) {
      patch.title = title;
      changedFields.push("title");
    }
    if (input.notes !== undefined && input.notes !== project.notes) {
      patch.notes = input.notes;
      changedFields.push("notes");
    }
    if (
      input.ownerMemberId !== undefined &&
      input.ownerMemberId !== project.ownerMemberId
    ) {
      patch.ownerMemberId = input.ownerMemberId;
      changedFields.push("ownerMemberId");
    }
    if (input.dueDate !== undefined && input.dueDate !== project.dueDate) {
      patch.dueDate = input.dueDate;
      changedFields.push("dueDate");
    }
    if (
      input.scheduledDate !== undefined &&
      input.scheduledDate !== project.scheduledDate
    ) {
      patch.scheduledDate = input.scheduledDate;
      changedFields.push("scheduledDate");
    }
    if (input.position !== undefined && input.position !== project.position) {
      patch.position = input.position;
    }

    const existingTagIds = sortedIds(
      tx
        .select({ tagId: schema.workItemTags.tagId })
        .from(schema.workItemTags)
        .where(eq(schema.workItemTags.workItemId, id))
        .all()
        .map((row) => row.tagId),
    );
    const nextTagIds =
      input.tagIds === undefined ? existingTagIds : sortedIds(input.tagIds);
    const tagsChanged = !sameIds(existingTagIds, nextTagIds);
    const existingContextIds = sortedIds(
      tx
        .select({ contextId: schema.workItemPhysicalContexts.contextId })
        .from(schema.workItemPhysicalContexts)
        .where(eq(schema.workItemPhysicalContexts.workItemId, id))
        .all()
        .map((row) => row.contextId),
    );
    const nextContextIds =
      input.contextIds === undefined
        ? existingContextIds
        : sortedIds(input.contextIds);
    assertPhysicalContextsExist(txDb, nextContextIds);
    const contextsChanged = !sameIds(existingContextIds, nextContextIds);

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = nowIso();
      tx.update(schema.workItems).set(patch).where(eq(schema.workItems.id, id)).run();
    }

    if (tagsChanged) {
      tx.delete(schema.workItemTags)
        .where(eq(schema.workItemTags.workItemId, id))
        .run();
      for (const tagId of nextTagIds) {
        tx.insert(schema.workItemTags).values({ workItemId: id, tagId }).run();
      }
    }
    if (contextsChanged) {
      tx.delete(schema.workItemPhysicalContexts)
        .where(eq(schema.workItemPhysicalContexts.workItemId, id))
        .run();
      for (const contextId of nextContextIds) {
        tx.insert(schema.workItemPhysicalContexts)
          .values({ workItemId: id, contextId })
          .run();
      }
    }
    if (Object.keys(patch).length > 0 || tagsChanged || contextsChanged) {
      touchProject(txDb, id);
    }
    const updated = getProjectOrThrow(txDb, id);
    if (changedFields.length > 0) {
      const activityEventId = recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "project_updated",
        entityType: "project",
        entityTitle: updated.title,
        projectId: id,
        metadata: {
          changedFields: [
            ...changedFields,
            ...(tagsChanged ? ["tags"] : []),
            ...(contextsChanged ? ["contexts"] : []),
          ],
        },
      });
      if (project.ownerMemberId === null && updated.ownerMemberId !== null) {
        recordContribution(txDb, {
          activityEventId,
          actorMemberId: actor(context),
          category: "planning",
          reason: "project_driver_assigned",
          entityType: "project",
          entityId: id,
          personalEligible: true,
        });
      } else if (
        project.ownerMemberId !== null &&
        updated.ownerMemberId === null
      ) {
        neutralizeContribution(txDb, {
          activityEventId,
          reason: "project_driver_assigned",
          entityType: "project",
          entityId: id,
        });
      }
      if (
        project.ownerMemberId !== updated.ownerMemberId &&
        updated.ownerMemberId !== null
      ) {
        enqueueProjectAssignment(txDb, updated, activityEventId, context);
      }
    } else if (tagsChanged || contextsChanged) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: contextsChanged
          ? "project_contexts_changed"
          : "project_tags_changed",
        entityType: "project",
        entityTitle: updated.title,
        projectId: id,
        metadata: {},
      });
    }
    return updated;
  });
}

export function appendProjectNotes(
  db: Db,
  id: number,
  content: string,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    const notes = appendNoteContent(project.notes, content);
    if (notes === project.notes) return project;
    const updated = tx
      .update(schema.workItems)
      .set({
        notes,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.id, id))
      .returning()
      .get();
    const returned = {
      ...updated,
      status: projectStatusFromStored(updated.status, updated.archivedAt),
    };
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_updated",
      entityType: "project",
      entityTitle: returned.title,
      projectId: id,
      metadata: { changedFields: ["notesAppended"] },
    });
    return returned;
  });
}

/**
 * Permanently removes a project while preserving its tasks. The projects FK
 * uses ON DELETE SET NULL for tasks, while project tags and completion
 * criteria cascade with the deleted project.
 */
export function deleteProject(db: Db, id: number, context?: MutationContext) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    tx.update(schema.workItems)
      .set({
        parentId: null,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workItems.parentId, id))
      .run();
    tx.delete(schema.workItems).where(eq(schema.workItems.id, id)).run();
    const activityEventId = recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_deleted",
      entityType: "project",
      entityTitle: project.title,
      metadata: {},
    });
    neutralizeEntityContributions(txDb, {
      activityEventId,
      entityType: "project",
      entityId: id,
    });
  });
}
