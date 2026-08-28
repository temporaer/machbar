import { and, eq, inArray } from "drizzle-orm";
import type {
  InheritanceMode,
  ProjectStatus,
  TagGroupingMode,
  TagKind,
  TaskSize,
  TaskStatus,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  getDescendantIds as repoGetDescendantIds,
  recordActivity,
  wouldCreateDependencyCycle,
  wouldCreateHierarchyCycle,
} from "../repo/index.js";

export interface MutationContext {
  actorMemberId?: number | null;
}

function actor(context?: MutationContext): number | null {
  return context?.actorMemberId ?? null;
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sortedIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendNoteContent(existing: string, incoming: string): string {
  const appended = incoming.trim();
  if (appended === "") return existing;
  if (existing.trim() === "") return appended;
  if (existing.endsWith("\n\n")) return `${existing}${appended}`;
  if (existing.endsWith("\n")) return `${existing}\n${appended}`;
  return `${existing}\n\n${appended}`;
}

// ---------------------------------------------------------------------------
// Tags & members
// ---------------------------------------------------------------------------

export function listMembers(db: Db) {
  return db
    .select({
      id: schema.members.id,
      name: schema.members.name,
      color: schema.members.color,
      oidcMemberId: schema.memberOidcIdentities.memberId,
      pictureUrl: schema.memberOidcIdentities.pictureUrl,
    })
    .from(schema.members)
    .leftJoin(
      schema.memberOidcIdentities,
      eq(schema.members.id, schema.memberOidcIdentities.memberId),
    )
    .all()
    .map(({ oidcMemberId, ...member }) => ({
      ...member,
      pictureUrl: member.pictureUrl ?? null,
      managedByOidc: oidcMemberId !== null,
    }));
}

export function getMemberOrThrow(db: Db, id: number) {
  const member = db.select().from(schema.members).where(eq(schema.members.id, id)).get();
  if (!member) {
    throw AppError.notFound(
      "member_not_found",
      "The requested member was not found.",
      { memberId: id },
    );
  }
  return member;
}

function normalizeMemberName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw AppError.badRequest(
      "member_name_required",
      "The member name must not be empty.",
    );
  }
  return trimmed;
}

function assertMemberNotOidcManaged(db: Db, id: number): void {
  const identity = db
    .select({ memberId: schema.memberOidcIdentities.memberId })
    .from(schema.memberOidcIdentities)
    .where(eq(schema.memberOidcIdentities.memberId, id))
    .get();
  if (identity) {
    throw AppError.conflict(
      "member_oidc_managed",
      "This member is managed by Pocket ID and cannot be renamed or deleted here.",
      { memberId: id },
    );
  }
}

export function createMember(db: Db, name: string) {
  const trimmed = normalizeMemberName(name);
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.members)
      .where(eq(schema.members.name, trimmed))
      .get();
    if (existing) {
      throw AppError.conflict(
        "member_name_conflict",
        "A member with this name already exists.",
        { name: trimmed, conflictingMemberId: existing.id },
      );
    }
    const member = tx
      .insert(schema.members)
      .values({ name: trimmed, color: "" })
      .returning()
      .get();
    return { ...member, pictureUrl: null, managedByOidc: false };
  });
}

export function renameMember(db: Db, id: number, name: string) {
  const trimmed = normalizeMemberName(name);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getMemberOrThrow(txDb, id);
    assertMemberNotOidcManaged(txDb, id);
    const existing = tx
      .select()
      .from(schema.members)
      .where(eq(schema.members.name, trimmed))
      .get();
    if (existing && existing.id !== id) {
      throw AppError.conflict(
        "member_name_conflict",
        "A member with this name already exists.",
        { name: trimmed, conflictingMemberId: existing.id },
      );
    }
    tx.update(schema.members).set({ name: trimmed }).where(eq(schema.members.id, id)).run();
    const member = tx
      .select()
      .from(schema.members)
      .where(eq(schema.members.id, id))
      .get()!;
    return { ...member, pictureUrl: null, managedByOidc: false };
  });
}

/**
 * Deletes a household member. Any project/task references to the member
 * (as owner, and for tasks also as creator) are cleared to `null` first, in
 * the same transaction as the deletion itself, so projects and tasks are
 * always preserved — deleting a member never cascades into deleting the
 * work they were associated with. For tasks whose owner-inheritance mode is
 * `"inherit"`, the (now-unused) `ownerMemberId` column is cleared too, but
 * their effective owner keeps resolving from the project as before; for
 * `"explicit"` tasks the explicit owner simply becomes unset, which is a
 * valid, already-supported state (the column and inheritance mode are both
 * nullable/independent of one another).
 */
export function deleteMember(db: Db, id: number) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getMemberOrThrow(txDb, id);
    assertMemberNotOidcManaged(txDb, id);

    const now = nowIso();
    tx.update(schema.projects)
      .set({ ownerMemberId: null, updatedAt: now })
      .where(eq(schema.projects.ownerMemberId, id))
      .run();
    tx.update(schema.tasks)
      .set({ ownerMemberId: null, updatedAt: now })
      .where(eq(schema.tasks.ownerMemberId, id))
      .run();
    tx.update(schema.tasks)
      .set({ createdByMemberId: null, updatedAt: now })
      .where(eq(schema.tasks.createdByMemberId, id))
      .run();

    tx.delete(schema.members).where(eq(schema.members.id, id)).run();
  });
}

export function listTags(db: Db) {
  const kindOrder: Record<TagKind, number> = {
    area: 0,
    actor: 1,
    context: 2,
    plain: 3,
  };
  return db
    .select()
    .from(schema.tags)
    .all()
    .sort((a, b) => {
      const kindDiff =
        kindOrder[a.kind as TagKind] - kindOrder[b.kind as TagKind];
      if (kindDiff !== 0) return kindDiff;
      const pinnedDiff =
        Number(b.groupingMode === "pinned") -
        Number(a.groupingMode === "pinned");
      if (pinnedDiff !== 0) return pinnedDiff;
      const positionDiff =
        (a.sortPosition ?? Number.MAX_SAFE_INTEGER) -
        (b.sortPosition ?? Number.MAX_SAFE_INTEGER);
      if (positionDiff !== 0) return positionDiff;
      const nameDiff = a.name.localeCompare(b.name, "de");
      return nameDiff !== 0 ? nameDiff : a.id - b.id;
    });
}

const tagColors = [
  "#2563eb",
  "#7c3aed",
  "#c026d3",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#4f46e5",
] as const;

export function colorForTag(name: string): string {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return tagColors[hash % tagColors.length]!;
}

export function getOrCreateTag(
  db: Db,
  name: string,
  kind: TagKind = "plain",
) {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw AppError.badRequest(
      "tag_name_required",
      "The tag name must not be empty.",
    );
  }
  const existing = db
    .select()
    .from(schema.tags)
    .where(eq(schema.tags.name, trimmed))
    .get();
  if (existing) {
    if (existing.kind !== kind) {
      throw AppError.conflict(
        "tag_kind_conflict",
        "A tag with this name already exists with a different kind.",
        {
          name: trimmed,
          existingTagId: existing.id,
          existingKind: existing.kind,
          requestedKind: kind,
        },
      );
    }
    return existing;
  }
  return db
    .insert(schema.tags)
    .values({ name: trimmed, color: colorForTag(trimmed), kind })
    .returning()
    .get();
}

export interface UpdateTagInput {
  name?: string;
  kind?: TagKind;
  groupingMode?: TagGroupingMode;
  sortPosition?: number | null;
}

export function updateTag(db: Db, id: number, input: UpdateTagInput) {
  const tag = db.select().from(schema.tags).where(eq(schema.tags.id, id)).get();
  if (!tag) {
    throw AppError.notFound(
      "tag_not_found",
      "The requested tag was not found.",
      { tagId: id },
    );
  }
  const patch: Partial<typeof schema.tags.$inferInsert> = {};
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed === "") {
      throw AppError.badRequest(
        "tag_name_required",
        "The tag name must not be empty.",
      );
    }
    const existing = db
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.name, trimmed))
      .get();
    if (existing && existing.id !== id) {
      throw AppError.conflict(
        "tag_name_conflict",
        "A tag with this name already exists.",
        { name: trimmed, conflictingTagId: existing.id },
      );
    }
    patch.name = trimmed;
  }
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.groupingMode !== undefined) {
    patch.groupingMode = input.groupingMode;
  }
  if (input.sortPosition !== undefined) patch.sortPosition = input.sortPosition;
  if (Object.keys(patch).length === 0) return tag;
  return db
    .update(schema.tags)
    .set(patch)
    .where(eq(schema.tags.id, id))
    .returning()
    .get();
}

export function deleteTag(db: Db, id: number): void {
  const tag = db.select().from(schema.tags).where(eq(schema.tags.id, id)).get();
  if (!tag) {
    throw AppError.notFound(
      "tag_not_found",
      "The requested tag was not found.",
      { tagId: id },
    );
  }
  db.delete(schema.tags).where(eq(schema.tags.id, id)).run();
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  title: string;
  notes?: string;
  status?: ProjectStatus;
  ownerMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  tagIds?: number[];
}

export function getProjectOrThrow(db: Db, id: number) {
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .get();
  if (!project) {
    throw AppError.notFound(
      "project_not_found",
      "The requested project was not found.",
      { projectId: id },
    );
  }
  return project;
}

/**
 * New stories always start in `backlog` unless a status is explicitly
 * requested (used by fixtures/tests and direct API creation) — there is no
 * driver requirement at creation time itself, only when a story is
 * explicitly *activated* via {@link activateProject} (see below).
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
    const maxPosition = tx
      .select({ position: schema.projects.position })
      .from(schema.projects)
      .all()
      .reduce((max, p) => Math.max(max, p.position), -1);

    const project = tx
      .insert(schema.projects)
      .values({
        title: input.title.trim(),
        notes: input.notes ?? "",
        status: input.status ?? "backlog",
        ownerMemberId: input.ownerMemberId ?? null,
        dueDate: input.dueDate ?? null,
        scheduledDate: input.scheduledDate ?? null,
        position: maxPosition + 1,
      })
      .returning()
      .get();

    if (input.tagIds && input.tagIds.length > 0) {
      for (const tagId of input.tagIds) {
        tx.insert(schema.projectTags)
          .values({ projectId: project.id, tagId })
          .run();
      }
    }
    recordActivity(tx as unknown as Db, {
      actorMemberId: actor(context),
      kind: "project_created",
      entityType: "project",
      entityTitle: project.title,
      projectId: project.id,
      metadata: {},
    });
    return project;
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
    const patch: Partial<typeof schema.projects.$inferInsert> = {};
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
        .select({ tagId: schema.projectTags.tagId })
        .from(schema.projectTags)
        .where(eq(schema.projectTags.projectId, id))
        .all()
        .map((row) => row.tagId),
    );
    const nextTagIds =
      input.tagIds === undefined ? existingTagIds : sortedIds(input.tagIds);
    const tagsChanged = !sameIds(existingTagIds, nextTagIds);

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = nowIso();
      tx.update(schema.projects).set(patch).where(eq(schema.projects.id, id)).run();
    }

    if (tagsChanged) {
      tx.delete(schema.projectTags)
        .where(eq(schema.projectTags.projectId, id))
        .run();
      for (const tagId of nextTagIds) {
        tx.insert(schema.projectTags).values({ projectId: id, tagId }).run();
      }
    }
    const updated = tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    if (changedFields.length > 0) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "project_updated",
        entityType: "project",
        entityTitle: updated.title,
        projectId: id,
        metadata: {
          changedFields: tagsChanged ? [...changedFields, "tags"] : changedFields,
        },
      });
    } else if (tagsChanged) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "project_tags_changed",
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
      .update(schema.projects)
      .set({ notes, updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .returning()
      .get();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_updated",
      entityType: "project",
      entityTitle: updated.title,
      projectId: id,
      metadata: { changedFields: ["notesAppended"] },
    });
    return updated;
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
    tx.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_deleted",
      entityType: "project",
      entityTitle: project.title,
      metadata: {},
    });
  });
}

// ---------------------------------------------------------------------------
// Explicit workflow transitions
// ---------------------------------------------------------------------------
//
// A story moves through `backlog -> active -> completed`, with `archived`
// reachable (and, symmetrically, escapable back into `backlog`/`active`)
// from any point. Every transition is its own small, transactional
// function; `availableProjectWorkflowActions` is the single source of
// truth both for validating a requested transition and for advertising
// which actions are currently legal in API responses.

export type ProjectWorkflowAction =
  | "activate"
  | "return_to_backlog"
  | "complete"
  | "reopen"
  | "archive";

const workflowActionsByStatus: Record<ProjectStatus, ProjectWorkflowAction[]> = {
  backlog: ["activate", "archive"],
  active: ["return_to_backlog", "complete", "archive"],
  completed: ["reopen", "archive"],
  archived: ["activate", "return_to_backlog"],
};

export function availableProjectWorkflowActions(
  status: ProjectStatus,
): ProjectWorkflowAction[] {
  return workflowActionsByStatus[status];
}

function assertWorkflowAction(
  project: { id: number; status: string },
  action: ProjectWorkflowAction,
) {
  const status = project.status as ProjectStatus;
  if (!availableProjectWorkflowActions(status).includes(action)) {
    throw AppError.conflict(
      "project_transition_invalid",
      "The requested project status transition is not allowed.",
      {
        projectId: project.id,
        currentStatus: status,
        action,
        allowedActions: availableProjectWorkflowActions(status),
      },
    );
  }
}

export interface ActivateProjectInput {
  ownerMemberId?: number | null;
}

/**
 * `backlog`/`archived` -> `active`. A story can only ever become active
 * once it has a driver: either already set on the project, or supplied
 * here in the same call (which also lets activation double as "assign the
 * driver and start work" in one step).
 */
export function activateProject(
  db: Db,
  id: number,
  input: ActivateProjectInput = {},
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(project, "activate");
    const ownerMemberId =
      input.ownerMemberId !== undefined ? input.ownerMemberId : project.ownerMemberId;
    if (ownerMemberId === null) {
      throw AppError.badRequest(
        "project_driver_required",
        "A project driver is required before the project can be activated.",
        { projectId: id },
      );
    }
    tx.update(schema.projects)
      .set({ status: "active", ownerMemberId, updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    const updated = tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_status_changed",
      entityType: "project",
      entityTitle: updated.title,
      projectId: id,
      metadata: {
        previousStatus: project.status as ProjectStatus,
        nextStatus: "active",
        ...(ownerMemberId !== project.ownerMemberId
          ? { changedFields: ["ownerMemberId"] }
          : {}),
      },
    });
    return updated;
  });
}

/**
 * `active`/`archived` -> `backlog`. The only way for a story to reach a
 * state where its driver may be cleared again.
 */
export function returnProjectToBacklog(
  db: Db,
  id: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(project, "return_to_backlog");
    tx.update(schema.projects)
      .set({ status: "backlog", updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    const updated = tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_status_changed",
      entityType: "project",
      entityTitle: updated.title,
      projectId: id,
      metadata: {
        previousStatus: project.status as ProjectStatus,
        nextStatus: "backlog",
      },
    });
    return updated;
  });
}

/**
 * `active` -> `completed`. Always a deliberate, manual decision: nothing
 * auto-completes a story just because every task is done/cancelled — that
 * situation only ever surfaces as the `completion_review` stuck reason,
 * prompting a human to call this action (or {@link reopenProject}/
 * {@link archiveProject} instead).
 */
export function completeProject(db: Db, id: number, context?: MutationContext) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(project, "complete");
    tx.update(schema.projects)
      .set({ status: "completed", updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    const updated = tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_status_changed",
      entityType: "project",
      entityTitle: updated.title,
      projectId: id,
      metadata: { previousStatus: "active", nextStatus: "completed" },
    });
    return updated;
  });
}

/** `completed` -> `active` again. The driver is retained unchanged. */
export function reopenProject(db: Db, id: number, context?: MutationContext) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(project, "reopen");
    tx.update(schema.projects)
      .set({ status: "active", updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    const updated = tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_status_changed",
      entityType: "project",
      entityTitle: updated.title,
      projectId: id,
      metadata: { previousStatus: "completed", nextStatus: "active" },
    });
    return updated;
  });
}

/**
 * `backlog`/`active`/`completed` -> `archived`. Shelves/retires a story
 * without touching its driver.
 */
export function archiveProject(db: Db, id: number, context?: MutationContext) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(project, "archive");
    tx.update(schema.projects)
      .set({ status: "archived", updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    const updated = tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_status_changed",
      entityType: "project",
      entityTitle: updated.title,
      projectId: id,
      metadata: {
        previousStatus: project.status as ProjectStatus,
        nextStatus: "archived",
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Acceptance criteria (ordered, structured; replaces free-text description)
// ---------------------------------------------------------------------------

function getCriterionOrThrow(db: Db, projectId: number, criterionId: number) {
  const criterion = db
    .select()
    .from(schema.projectAcceptanceCriteria)
    .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
    .get();
  if (!criterion || criterion.projectId !== projectId) {
    throw AppError.notFound(
      "acceptance_criterion_not_found",
      "The requested acceptance criterion was not found in this project.",
      { projectId, criterionId },
    );
  }
  return criterion;
}

function normalizeCriterionText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw AppError.badRequest(
      "acceptance_criterion_text_required",
      "The acceptance criterion text must not be empty.",
    );
  }
  return trimmed;
}

/** Appends a new criterion at the end of the project's ordered list. */
export function addCriterion(
  db: Db,
  projectId: number,
  text: string,
  context?: MutationContext,
) {
  const trimmed = normalizeCriterionText(text);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    const maxPosition = tx
      .select({ position: schema.projectAcceptanceCriteria.position })
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
      .all()
      .reduce((max, c) => Math.max(max, c.position), -1);
    const criterion = tx
      .insert(schema.projectAcceptanceCriteria)
      .values({ projectId, text: trimmed, position: maxPosition + 1 })
      .returning()
      .get();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_acceptance_criterion_added",
      entityType: "project",
      entityTitle: project.title,
      projectId,
      metadata: {},
    });
    return criterion;
  });
}

/** Edits a criterion's text without changing its position/checked state. */
export function updateCriterionText(
  db: Db,
  projectId: number,
  criterionId: number,
  text: string,
  context?: MutationContext,
) {
  const trimmed = normalizeCriterionText(text);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    const criterion = getCriterionOrThrow(txDb, projectId, criterionId);
    if (criterion.text === trimmed) return criterion;
    tx.update(schema.projectAcceptanceCriteria)
      .set({ text: trimmed, updatedAt: nowIso() })
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .run();
    const updated = tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_acceptance_criterion_updated",
      entityType: "project",
      entityTitle: project.title,
      projectId,
      metadata: {},
    });
    return updated;
  });
}

/** Checks/unchecks a single criterion (completion itself stays manual). */
export function setCriterionChecked(
  db: Db,
  projectId: number,
  criterionId: number,
  checked: boolean,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    const criterion = getCriterionOrThrow(txDb, projectId, criterionId);
    if (criterion.checked === checked) return criterion;
    tx.update(schema.projectAcceptanceCriteria)
      .set({ checked, updatedAt: nowIso() })
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .run();
    const updated = tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_acceptance_criterion_checked",
      entityType: "project",
      entityTitle: project.title,
      projectId,
      metadata: { checked },
    });
    return updated;
  });
}

/**
 * Reorders a project's criteria: `orderedCriterionIds` must be exactly the
 * project's existing criterion ids, each listed once, in the desired
 * order — anything else (missing/extra/duplicate/foreign ids) is rejected
 * so positions can never end up sparse or ambiguous.
 */
export function reorderCriteria(
  db: Db,
  projectId: number,
  orderedCriterionIds: number[],
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getProjectOrThrow(txDb, projectId);
    const existing = tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
      .all();
    const existingIds = new Set(existing.map((c) => c.id));
    const uniqueRequestedIds = new Set(orderedCriterionIds);
    const isValidReordering =
      orderedCriterionIds.length === existing.length &&
      uniqueRequestedIds.size === orderedCriterionIds.length &&
      orderedCriterionIds.every((id) => existingIds.has(id));
    if (!isValidReordering) {
      throw AppError.badRequest(
        "acceptance_criteria_order_invalid",
        "The criterion order must contain every existing criterion exactly once.",
        {
          projectId,
          requestedCriterionIds: orderedCriterionIds,
          existingCriterionIds: existing.map((criterion) => criterion.id),
        },
      );
    }
    orderedCriterionIds.forEach((criterionId, index) => {
      tx.update(schema.projectAcceptanceCriteria)
        .set({ position: index, updatedAt: nowIso() })
        .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
        .run();
    });
    return tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
      .all()
      .sort((a, b) => a.position - b.position);
  });
}

/** Removes a criterion and compacts the remaining positions (no gaps). */
export function removeCriterion(
  db: Db,
  projectId: number,
  criterionId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    getCriterionOrThrow(txDb, projectId, criterionId);
    tx.delete(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .run();
    const remaining = tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
      .all()
      .sort((a, b) => a.position - b.position);
    remaining.forEach((criterion, index) => {
      if (criterion.position !== index) {
        tx.update(schema.projectAcceptanceCriteria)
          .set({ position: index, updatedAt: nowIso() })
          .where(eq(schema.projectAcceptanceCriteria.id, criterion.id))
          .run();
      }
    });
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_acceptance_criterion_removed",
      entityType: "project",
      entityTitle: project.title,
      projectId,
      metadata: {},
    });
  });
}

// ---------------------------------------------------------------------------
// Task read helpers
// ---------------------------------------------------------------------------

export function getTaskOrThrow(db: Db, id: number) {
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!task) {
    throw AppError.notFound(
      "task_not_found",
      "The requested task was not found.",
      { taskId: id },
    );
  }
  return task;
}

/** All descendants (any depth, any status) of a task, flattened. */
export function listDescendants(db: Db, rootId: number) {
  const ids = repoGetDescendantIds(db, rootId);
  return ids.map((id) => getTaskOrThrow(db, id));
}

// ---------------------------------------------------------------------------
// Task create / update
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  projectId?: number | null;
  parentTaskId?: number | null;
  title: string;
  notes?: string;
  status?: TaskStatus;
  needsClarification?: boolean;
  ownerMemberId?: number | null;
  ownerInheritanceMode?: InheritanceMode;
  createdByMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  waitingFor?: string | null;
  priority?: number | null;
  size?: TaskSize | null;
  recurrenceRule?: string | null;
  reminderAt?: string | null;
  tagIds?: number[];
}

function normalizeTaskStatus(
  status: TaskStatus | undefined,
  needsClarification: boolean | undefined,
  fallback: TaskStatus,
): TaskStatus {
  if (status !== undefined && status !== "actionable") return status;
  if (needsClarification === true) return "captured";
  if (status !== undefined || needsClarification === false) return "actionable";
  return fallback;
}

function nextPositionForGroup(
  db: Db,
  parentTaskId: number | null,
  projectId: number | null,
): number {
  // SQLite's `= NULL` never matches, so sibling grouping is filtered in JS
  // rather than expressed as a drizzle `eq()` predicate.
  const rows = db.select().from(schema.tasks).all();
  const filtered = rows.filter(
    (r) => r.parentTaskId === parentTaskId && r.projectId === projectId,
  );
  return filtered.reduce((max, r) => Math.max(max, r.position), -1) + 1;
}

function insertTask(
  db: Db,
  input: CreateTaskInput,
  positionOverride?: number,
) {
  if (!input.title || input.title.trim() === "") {
    throw AppError.badRequest(
      "task_title_required",
      "The task title must not be empty.",
    );
  }
  let projectId = input.projectId ?? null;
  const parentTaskId = input.parentTaskId ?? null;

  if (parentTaskId !== null) {
    const parent = getTaskOrThrow(db, parentTaskId);
    projectId = parent.projectId;
  } else if (projectId !== null) {
    getProjectOrThrow(db, projectId);
  }

  const position =
    positionOverride ?? nextPositionForGroup(db, parentTaskId, projectId);
  const status = normalizeTaskStatus(
    input.status,
    input.needsClarification,
    projectId === null && parentTaskId === null ? "captured" : "actionable",
  );

  const task = db
    .insert(schema.tasks)
    .values({
      projectId,
      parentTaskId,
      title: input.title.trim(),
      notes: input.notes ?? "",
      status,
      needsClarification: status === "captured",
      ownerMemberId: input.ownerMemberId ?? null,
      ownerInheritanceMode: input.ownerInheritanceMode ?? "inherit",
      createdByMemberId: input.createdByMemberId ?? null,
      dueDate: input.dueDate ?? null,
      scheduledDate: input.scheduledDate ?? null,
      waitingFor: input.waitingFor ?? null,
      priority: input.priority ?? null,
      size: input.size ?? null,
      position,
    })
    .returning()
    .get();

  if (input.tagIds && input.tagIds.length > 0) {
    for (const tagId of input.tagIds) {
      db.insert(schema.taskTags).values({ taskId: task.id, tagId }).run();
    }
  }
  return task;
}

export function createTask(
  db: Db,
  input: CreateTaskInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = insertTask(txDb, input);
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_created",
      entityType: "task",
      entityTitle: task.title,
      taskId: task.id,
      projectId: task.projectId,
      metadata: {},
    });
    return task;
  });
}

export function createChildTask(
  db: Db,
  parentTaskId: number,
  input: Omit<CreateTaskInput, "parentTaskId" | "projectId">,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getTaskOrThrow(txDb, parentTaskId);
    const task = insertTask(txDb, { ...input, parentTaskId });
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_created",
      entityType: "task",
      entityTitle: task.title,
      taskId: task.id,
      projectId: task.projectId,
      metadata: {},
    });
    return task;
  });
}

export interface CreateTaskSequenceInput {
  titles: string[];
  createdByMemberId?: number | null;
}

function normalizedSequenceTitles(titles: string[]): string[] {
  const normalized = titles.map((title) => title.trim()).filter(Boolean);
  if (normalized.length < 2) {
    throw AppError.badRequest(
      "task_sequence_too_short",
      "A task sequence requires at least two named steps.",
      { minimum: 2, provided: normalized.length },
    );
  }
  return normalized;
}

/** Creates a self-contained top-level project chain atomically. */
export function createProjectTaskSequence(
  db: Db,
  projectId: number,
  input: CreateTaskSequenceInput,
  context?: MutationContext,
) {
  const titles = normalizedSequenceTitles(input.titles);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, projectId);
    const created: ReturnType<typeof insertTask>[] = [];

    for (const title of titles) {
      const task = insertTask(txDb, {
        projectId,
        title,
        status: "actionable",
        createdByMemberId: input.createdByMemberId ?? null,
      });
      const predecessor = created.at(-1);
      if (predecessor) {
        tx
          .insert(schema.taskDependencies)
          .values({ taskId: task.id, dependsOnTaskId: predecessor.id })
          .run();
      }
      created.push(task);
    }

    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "project_updated",
      entityType: "project",
      entityTitle: project.title,
      projectId,
      metadata: {
        changedFields: ["taskSequence"],
        affectedCount: created.length,
        relatedTaskIds: created.map((task) => task.id),
        relatedTaskTitles: created.map((task) => task.title),
      },
    });
    return created;
  });
}

/** Creates one sibling immediately downstream of an existing task. */
export function createTaskSuccessor(
  db: Db,
  taskId: number,
  input: Omit<CreateTaskInput, "parentTaskId" | "projectId">,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const predecessor = getTaskOrThrow(txDb, taskId);
    const successorPosition = predecessor.position + 1;
    const laterSiblings = tx
      .select()
      .from(schema.tasks)
      .all()
      .filter(
        (task) =>
          task.parentTaskId === predecessor.parentTaskId &&
          task.projectId === predecessor.projectId &&
          task.position >= successorPosition,
      );
    for (const sibling of laterSiblings) {
      tx
        .update(schema.tasks)
        .set({ position: sibling.position + 1, updatedAt: nowIso() })
        .where(eq(schema.tasks.id, sibling.id))
        .run();
    }
    const successor = insertTask(txDb, {
      ...input,
      status: input.status ?? "actionable",
      projectId: predecessor.projectId,
      parentTaskId: predecessor.parentTaskId,
    }, successorPosition);
    tx
      .insert(schema.taskDependencies)
      .values({ taskId: successor.id, dependsOnTaskId: predecessor.id })
      .run();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_created",
      entityType: "task",
      entityTitle: successor.title,
      taskId: successor.id,
      projectId: successor.projectId,
      metadata: {
        relatedTaskIds: [predecessor.id],
        relatedTaskTitles: [predecessor.title],
      },
    });
    return successor;
  });
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  needsClarification?: boolean;
  ownerMemberId?: number | null;
  ownerInheritanceMode?: InheritanceMode;
  dueDate?: string | null;
  scheduledDate?: string | null;
  waitingFor?: string | null;
  priority?: number | null;
  size?: TaskSize | null;
  recurrenceRule?: string | null;
  reminderAt?: string | null;
  tagIds?: number[];
  excludedTagIds?: number[];
}

export function updateTask(
  db: Db,
  id: number,
  input: UpdateTaskInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const currentTask = getTaskOrThrow(txDb, id);
    if (input.title !== undefined && input.title.trim() === "") {
      throw AppError.badRequest(
        "task_title_required",
        "The task title must not be empty.",
        { taskId: id },
      );
    }
    const patch: Partial<typeof schema.tasks.$inferInsert> = {};
    const changedFields: string[] = [];
    const title = input.title?.trim();
    if (title !== undefined && title !== currentTask.title) {
      patch.title = title;
      changedFields.push("title");
    }
    if (input.notes !== undefined && input.notes !== currentTask.notes) {
      patch.notes = input.notes;
      changedFields.push("notes");
    }
    const nextStatus =
      input.status !== undefined
        ? normalizeTaskStatus(
            input.status,
            input.needsClarification,
            "actionable",
          )
        : input.needsClarification === true
          ? "captured"
          : input.needsClarification === false && currentTask.status === "captured"
            ? "actionable"
            : undefined;
    const statusChanged =
      nextStatus !== undefined && nextStatus !== currentTask.status;
    if (statusChanged) {
      patch.status = nextStatus;
      patch.needsClarification = nextStatus === "captured";
      patch.completedAt = nextStatus === "done" ? nowIso() : null;
      patch.cancelledAt = nextStatus === "cancelled" ? nowIso() : null;
    }
    if (
      input.ownerMemberId !== undefined &&
      input.ownerMemberId !== currentTask.ownerMemberId
    ) {
      changedFields.push("ownerMemberId");
      patch.ownerMemberId = input.ownerMemberId;
    }
    if (
      input.ownerInheritanceMode !== undefined &&
      input.ownerInheritanceMode !== currentTask.ownerInheritanceMode
    ) {
      changedFields.push("ownerInheritanceMode");
      patch.ownerInheritanceMode = input.ownerInheritanceMode;
    }
    for (const field of [
      "dueDate",
      "scheduledDate",
      "waitingFor",
      "priority",
      "size",
      "recurrenceRule",
      "reminderAt",
    ] as const) {
      if (input[field] !== undefined && input[field] !== currentTask[field]) {
        patch[field] = input[field] as never;
        changedFields.push(field);
      }
    }

    const existingTagIds = sortedIds(
      tx.select({ tagId: schema.taskTags.tagId })
        .from(schema.taskTags)
        .where(eq(schema.taskTags.taskId, id))
        .all()
        .map((row) => row.tagId),
    );
    const nextTagIds =
      input.tagIds === undefined ? existingTagIds : sortedIds(input.tagIds);
    const tagsChanged = !sameIds(existingTagIds, nextTagIds);
    const existingExcludedTagIds = sortedIds(
      tx.select({ tagId: schema.taskExcludedTags.tagId })
        .from(schema.taskExcludedTags)
        .where(eq(schema.taskExcludedTags.taskId, id))
        .all()
        .map((row) => row.tagId),
    );
    const nextExcludedTagIds =
      input.excludedTagIds === undefined
        ? existingExcludedTagIds
        : sortedIds(input.excludedTagIds);
    const excludedTagsChanged = !sameIds(
      existingExcludedTagIds,
      nextExcludedTagIds,
    );

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = nowIso();
      tx.update(schema.tasks).set(patch).where(eq(schema.tasks.id, id)).run();
    }

    if (tagsChanged) {
      tx.delete(schema.taskTags).where(eq(schema.taskTags.taskId, id)).run();
      for (const tagId of nextTagIds) {
        tx.insert(schema.taskTags).values({ taskId: id, tagId }).run();
      }
    }
    if (excludedTagsChanged) {
      tx.delete(schema.taskExcludedTags)
        .where(eq(schema.taskExcludedTags.taskId, id))
        .run();
      for (const tagId of nextExcludedTagIds) {
        tx.insert(schema.taskExcludedTags).values({ taskId: id, tagId }).run();
      }
    }
    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
    const coalescedChangedFields = [
      ...changedFields,
      ...(tagsChanged ? ["tags"] : []),
      ...(excludedTagsChanged ? ["excludedTags"] : []),
    ];
    if (statusChanged) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_status_changed",
        entityType: "task",
        entityTitle: updated.title,
        taskId: id,
        projectId: updated.projectId,
        metadata: {
          previousStatus: currentTask.status as TaskStatus,
          nextStatus: updated.status as TaskStatus,
          ...(coalescedChangedFields.length > 0
            ? { changedFields: coalescedChangedFields }
            : {}),
        },
      });
    } else if (changedFields.length > 0) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_updated",
        entityType: "task",
        entityTitle: updated.title,
        taskId: id,
        projectId: updated.projectId,
        metadata: { changedFields: coalescedChangedFields },
      });
    } else if (tagsChanged || excludedTagsChanged) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_tags_changed",
        entityType: "task",
        entityTitle: updated.title,
        taskId: id,
        projectId: updated.projectId,
        metadata: {},
      });
    }
    return updated;
  });
}

export function appendTaskNotes(
  db: Db,
  id: number,
  content: string,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    const notes = appendNoteContent(task.notes, content);
    if (notes === task.notes) return task;
    const updated = tx
      .update(schema.tasks)
      .set({ notes, updatedAt: nowIso() })
      .where(eq(schema.tasks.id, id))
      .returning()
      .get();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_updated",
      entityType: "task",
      entityTitle: updated.title,
      taskId: id,
      projectId: updated.projectId,
      metadata: { changedFields: ["notesAppended"] },
    });
    return updated;
  });
}

export function deleteTask(db: Db, id: number, context?: MutationContext) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    const affectedCount = repoGetDescendantIds(txDb, id).length + 1;
    tx.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_deleted",
      entityType: "task",
      entityTitle: task.title,
      projectId: task.projectId,
      metadata: affectedCount > 1 ? { affectedCount } : {},
    });
  });
}

// ---------------------------------------------------------------------------
// Complete / cancel / reopen with explicit descendants policy
// ---------------------------------------------------------------------------

export type CompleteDescendantsPolicy = "leave_open" | "complete_children";
export type CancelDescendantsPolicy = "leave_open" | "cancel_children";

function openDescendants(db: Db, id: number) {
  return listDescendants(db, id).filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  );
}

export function completeTask(
  db: Db,
  id: number,
  descendantsPolicy?: CompleteDescendantsPolicy,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    const openChildren = openDescendants(txDb, id);
    const descendantsOnly =
      task.status === "done" &&
      descendantsPolicy === "complete_children" &&
      openChildren.length > 0;
    if (
      task.status === "done" &&
      !descendantsOnly
    ) {
      return task;
    }
    if (openChildren.length > 0 && descendantsPolicy === undefined) {
      throw new AppError(
        409,
        "descendants_policy_required",
        "A descendants policy is required because this task has open children.",
        {
          taskId: id,
          transition: "complete",
          openChildrenCount: openChildren.length,
          options: ["leave_open", "complete_children"],
        },
      );
    }
    const now = nowIso();
    if (!descendantsOnly) {
      tx.update(schema.tasks)
        .set({
          status: "done",
          needsClarification: false,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, id))
        .run();
    }

    if (descendantsPolicy === "complete_children") {
      for (const child of openChildren) {
        tx.update(schema.tasks)
          .set({
            status: "done",
            needsClarification: false,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.tasks.id, child.id))
          .run();
      }
    }
    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: descendantsOnly
        ? "task_descendants_status_changed"
        : "task_status_changed",
      entityType: "task",
      entityTitle: updated.title,
      taskId: id,
      projectId: updated.projectId,
      metadata: descendantsOnly
        ? { nextStatus: "done", affectedCount: openChildren.length }
        : {
            previousStatus: task.status as TaskStatus,
            nextStatus: "done",
            ...(descendantsPolicy === "complete_children"
              ? { affectedCount: openChildren.length + 1 }
              : {}),
          },
    });
    return updated;
  });
}

export function cancelTask(
  db: Db,
  id: number,
  descendantsPolicy?: CancelDescendantsPolicy,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    const openChildren = openDescendants(txDb, id);
    const descendantsOnly =
      task.status === "cancelled" &&
      descendantsPolicy === "cancel_children" &&
      openChildren.length > 0;
    if (
      task.status === "cancelled" &&
      !descendantsOnly
    ) {
      return task;
    }
    if (openChildren.length > 0 && descendantsPolicy === undefined) {
      throw new AppError(
        409,
        "descendants_policy_required",
        "A descendants policy is required because this task has open children.",
        {
          taskId: id,
          transition: "cancel",
          openChildrenCount: openChildren.length,
          options: ["leave_open", "cancel_children"],
        },
      );
    }
    const now = nowIso();
    if (!descendantsOnly) {
      tx.update(schema.tasks)
        .set({
          status: "cancelled",
          needsClarification: false,
          cancelledAt: now,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, id))
        .run();
    }

    if (descendantsPolicy === "cancel_children") {
      for (const child of openChildren) {
        tx.update(schema.tasks)
          .set({
            status: "cancelled",
            needsClarification: false,
            cancelledAt: now,
            updatedAt: now,
          })
          .where(eq(schema.tasks.id, child.id))
          .run();
      }
    }
    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: descendantsOnly
        ? "task_descendants_status_changed"
        : "task_status_changed",
      entityType: "task",
      entityTitle: updated.title,
      taskId: id,
      projectId: updated.projectId,
      metadata: descendantsOnly
        ? { nextStatus: "cancelled", affectedCount: openChildren.length }
        : {
            previousStatus: task.status as TaskStatus,
            nextStatus: "cancelled",
            ...(descendantsPolicy === "cancel_children"
              ? { affectedCount: openChildren.length + 1 }
              : {}),
          },
    });
    return updated;
  });
}

export function reopenTask(db: Db, id: number, context?: MutationContext) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, id);
    if (task.status === "actionable") return task;
    const now = nowIso();
    tx.update(schema.tasks)
      .set({
        status: "actionable",
        needsClarification: false,
        completedAt: null,
        cancelledAt: null,
        updatedAt: now,
      })
      .where(eq(schema.tasks.id, id))
      .run();
    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_status_changed",
      entityType: "task",
      entityTitle: updated.title,
      taskId: id,
      projectId: updated.projectId,
      metadata: {
        previousStatus: task.status as TaskStatus,
        nextStatus: "actionable",
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Hierarchy: move / reorder / indent / outdent / change parent / move subtree
// ---------------------------------------------------------------------------

export interface MoveTaskInput {
  parentTaskId?: number | null;
  projectId?: number | null;
  position?: number;
}

function reindexGroup(
  tx: Db,
  parentTaskId: number | null,
  projectId: number | null,
  orderedIds: number[],
) {
  orderedIds.forEach((taskId, index) => {
    tx.update(schema.tasks)
      .set({ position: index, updatedAt: nowIso() })
      .where(eq(schema.tasks.id, taskId))
      .run();
  });
}

function siblingsOf(
  tx: Db,
  parentTaskId: number | null,
  projectId: number | null,
  excludeId: number,
) {
  const all = db_selectAllTasks(tx);
  return all
    .filter(
      (t) =>
        t.parentTaskId === parentTaskId &&
        t.projectId === projectId &&
        t.id !== excludeId,
    )
    .sort((a, b) => a.position - b.position);
}

function db_selectAllTasks(tx: Db) {
  return tx.select().from(schema.tasks).all();
}

function cascadeProjectId(tx: Db, rootId: number, newProjectId: number | null) {
  // A single recursive-CTE lookup (repo layer) resolves the whole subtree;
  // the update itself is then one ordinary batched Drizzle statement
  // instead of a per-node BFS loop with one query per level.
  const descendantIds = repoGetDescendantIds(tx, rootId);
  if (descendantIds.length === 0) return;
  tx.update(schema.tasks)
    .set({ projectId: newProjectId, updatedAt: nowIso() })
    .where(inArray(schema.tasks.id, descendantIds))
    .run();
}

/**
 * Core, transactional move used by reorder/indent/outdent/change-parent/
 * move-subtree. Detects hierarchy cycles, keeps a task's whole subtree in
 * the same project as its new parent, and renormalizes sibling positions
 * in both the source and destination groups so there are never gaps or
 * duplicate positions.
 */
export function moveTask(
  db: Db,
  taskId: number,
  input: MoveTaskInput,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);

    const newParentTaskId =
      "parentTaskId" in input ? input.parentTaskId ?? null : task.parentTaskId;

    let newProjectId: number | null;
    if (newParentTaskId !== null) {
      if (newParentTaskId === taskId) {
        throw AppError.conflict(
          "task_parent_self",
          "A task cannot be its own parent.",
          { taskId },
        );
      }
      const newParent = getTaskOrThrow(txDb, newParentTaskId);
      if (wouldCreateHierarchyCycle(txDb, taskId, newParentTaskId)) {
        throw AppError.conflict(
          "task_hierarchy_cycle",
          "This move would create a cycle in the task hierarchy.",
          { taskId, parentTaskId: newParentTaskId },
        );
      }
      newProjectId = newParent.projectId;
    } else {
      newProjectId = "projectId" in input ? input.projectId ?? null : task.projectId;
    }

    const movingWithinSameGroup =
      newParentTaskId === task.parentTaskId && newProjectId === task.projectId;

    const destinationSiblings = siblingsOf(
      txDb,
      newParentTaskId,
      newProjectId,
      taskId,
    );
    const rawIndex = input.position ?? destinationSiblings.length;
    const index = Math.max(0, Math.min(rawIndex, destinationSiblings.length));
    const destinationIds = destinationSiblings.map((t) => t.id);
    destinationIds.splice(index, 0, taskId);

    tx.update(schema.tasks)
      .set({
        parentTaskId: newParentTaskId,
        projectId: newProjectId,
        updatedAt: nowIso(),
      })
      .where(eq(schema.tasks.id, taskId))
      .run();

    if (newProjectId !== task.projectId) {
      cascadeProjectId(txDb, taskId, newProjectId);
    }

    reindexGroup(txDb, newParentTaskId, newProjectId, destinationIds);

    if (!movingWithinSameGroup) {
      const sourceSiblings = siblingsOf(
        txDb,
        task.parentTaskId,
        task.projectId,
        taskId,
      );
      reindexGroup(
        txDb,
        task.parentTaskId,
        task.projectId,
        sourceSiblings.map((t) => t.id),
      );
    }

    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
    if (!movingWithinSameGroup) {
      const destinationProject =
        newProjectId !== task.projectId && newProjectId !== null
          ? getProjectOrThrow(txDb, newProjectId)
          : null;
      const destinationParent =
        newParentTaskId !== null
          ? getTaskOrThrow(txDb, newParentTaskId)
          : null;
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_moved",
        entityType: "task",
        entityTitle: updated.title,
        taskId,
        projectId: updated.projectId,
        metadata: {
          ...(destinationProject
            ? {
                relatedProjectIds: [destinationProject.id],
                relatedProjectTitles: [destinationProject.title],
              }
            : {}),
          ...(destinationParent
            ? {
                relatedTaskIds: [destinationParent.id],
                relatedTaskTitles: [destinationParent.title],
              }
            : {}),
        },
      });
    }
    return updated;
  });
}

export function reorderTask(
  db: Db,
  taskId: number,
  position: number,
  context?: MutationContext,
) {
  return moveTask(db, taskId, { position }, context);
}

export function changeTaskParent(
  db: Db,
  taskId: number,
  parentTaskId: number | null,
  projectId?: number | null,
  context?: MutationContext,
) {
  const input: MoveTaskInput = { parentTaskId };
  if (parentTaskId === null && projectId !== undefined) {
    input.projectId = projectId;
  }
  return moveTask(db, taskId, input, context);
}

export function moveSubtreeToProject(
  db: Db,
  taskId: number,
  targetProjectId: number | null,
  context?: MutationContext,
) {
  return moveTask(
    db,
    taskId,
    { parentTaskId: null, projectId: targetProjectId },
    context,
  );
}

export function indentTask(db: Db, taskId: number, context?: MutationContext) {
  const task = getTaskOrThrow(db, taskId);
  const siblings = siblingsOf(db, task.parentTaskId, task.projectId, -1)
    .concat()
    .sort((a, b) => a.position - b.position);
  const currentIndex = siblings.findIndex((t) => t.id === taskId);
  if (currentIndex <= 0) {
    throw AppError.badRequest(
      "task_indent_unavailable",
      "There is no previous sibling under which this task can be indented.",
      { taskId },
    );
  }
  const previousSibling = siblings[currentIndex - 1]!;
  return moveTask(db, taskId, { parentTaskId: previousSibling.id }, context);
}

export function outdentTask(db: Db, taskId: number, context?: MutationContext) {
  const task = getTaskOrThrow(db, taskId);
  if (task.parentTaskId === null) {
    throw AppError.badRequest(
      "task_already_root",
      "This task is already at the root level.",
      { taskId },
    );
  }
  const parent = getTaskOrThrow(db, task.parentTaskId);
  const input: MoveTaskInput = {
    parentTaskId: parent.parentTaskId,
    position: parent.position + 1,
  };
  if (parent.parentTaskId === null) {
    input.projectId = parent.projectId;
  }
  return moveTask(db, taskId, input, context);
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export function addDependency(
  db: Db,
  taskId: number,
  dependsOnTaskId: number,
  context?: MutationContext,
) {
  if (taskId === dependsOnTaskId) {
    throw AppError.conflict(
      "task_dependency_self",
      "A task cannot depend on itself.",
      { taskId },
    );
  }
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const dependency = getTaskOrThrow(txDb, dependsOnTaskId);

    const existing = tx
      .select()
      .from(schema.taskDependencies)
      .where(
        and(
          eq(schema.taskDependencies.taskId, taskId),
          eq(schema.taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      )
      .get();
    if (existing) return existing;

    if (wouldCreateDependencyCycle(txDb, taskId, dependsOnTaskId)) {
      throw AppError.conflict(
        "task_dependency_cycle",
        "This dependency would create a cycle.",
        { taskId, dependsOnTaskId },
      );
    }

    const created = tx
      .insert(schema.taskDependencies)
      .values({ taskId, dependsOnTaskId })
      .returning()
      .get();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_dependencies_changed",
      entityType: "task",
      entityTitle: task.title,
      taskId,
      projectId: task.projectId,
      metadata: {
        relatedTaskIds: [dependency.id],
        relatedTaskTitles: [dependency.title],
      },
    });
    return created;
  });
}

export function removeDependency(
  db: Db,
  taskId: number,
  dependsOnTaskId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const dependency = getTaskOrThrow(txDb, dependsOnTaskId);
    const deleted = tx.delete(schema.taskDependencies)
      .where(
        and(
          eq(schema.taskDependencies.taskId, taskId),
          eq(schema.taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      )
      .run();
    if (deleted.changes > 0) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_dependencies_changed",
        entityType: "task",
        entityTitle: task.title,
        taskId,
        projectId: task.projectId,
        metadata: {
          relatedTaskIds: [dependency.id],
          relatedTaskTitles: [dependency.title],
        },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Tags on tasks
// ---------------------------------------------------------------------------

export function addTaskTag(
  db: Db,
  taskId: number,
  tagId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const existing = tx.select().from(schema.taskTags)
      .where(and(eq(schema.taskTags.taskId, taskId), eq(schema.taskTags.tagId, tagId)))
      .get();
    if (existing) return;
    tx.insert(schema.taskTags).values({ taskId, tagId }).run();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_tags_changed",
      entityType: "task",
      entityTitle: task.title,
      taskId,
      projectId: task.projectId,
      metadata: {},
    });
  });
}

export function removeTaskTag(
  db: Db,
  taskId: number,
  tagId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const deleted = tx.delete(schema.taskTags)
      .where(and(eq(schema.taskTags.taskId, taskId), eq(schema.taskTags.tagId, tagId)))
      .run();
    if (deleted.changes > 0) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_tags_changed",
        entityType: "task",
        entityTitle: task.title,
        taskId,
        projectId: task.projectId,
        metadata: {},
      });
    }
  });
}

export function addExcludedTag(
  db: Db,
  taskId: number,
  tagId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const existing = tx.select().from(schema.taskExcludedTags)
      .where(
        and(
          eq(schema.taskExcludedTags.taskId, taskId),
          eq(schema.taskExcludedTags.tagId, tagId),
        ),
      )
      .get();
    if (existing) return;
    tx.insert(schema.taskExcludedTags).values({ taskId, tagId }).run();
    recordActivity(txDb, {
      actorMemberId: actor(context),
      kind: "task_tags_changed",
      entityType: "task",
      entityTitle: task.title,
      taskId,
      projectId: task.projectId,
      metadata: {},
    });
  });
}

export function removeExcludedTag(
  db: Db,
  taskId: number,
  tagId: number,
  context?: MutationContext,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);
    const deleted = tx.delete(schema.taskExcludedTags)
      .where(
        and(
          eq(schema.taskExcludedTags.taskId, taskId),
          eq(schema.taskExcludedTags.tagId, tagId),
        ),
      )
      .run();
    if (deleted.changes > 0) {
      recordActivity(txDb, {
        actorMemberId: actor(context),
        kind: "task_tags_changed",
        entityType: "task",
        entityTitle: task.title,
        taskId,
        projectId: task.projectId,
        metadata: {},
      });
    }
  });
}
