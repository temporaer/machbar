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
  wouldCreateDependencyCycle,
  wouldCreateHierarchyCycle,
} from "../repo/index.js";

function nowIso(): string {
  return new Date().toISOString();
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
    })
    .from(schema.members)
    .leftJoin(
      schema.memberOidcIdentities,
      eq(schema.members.id, schema.memberOidcIdentities.memberId),
    )
    .all()
    .map(({ oidcMemberId, ...member }) => ({
      ...member,
      managedByOidc: oidcMemberId !== null,
    }));
}

export function getMemberOrThrow(db: Db, id: number) {
  const member = db.select().from(schema.members).where(eq(schema.members.id, id)).get();
  if (!member) {
    throw AppError.notFound(`Mitglied mit ID ${id} wurde nicht gefunden.`);
  }
  return member;
}

function normalizeMemberName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw AppError.badRequest("Der Name darf nicht leer sein.");
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
      "Dieses Mitglied wird von Pocket ID verwaltet und kann hier nicht umbenannt oder gelöscht werden.",
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
        `Ein Mitglied mit dem Namen "${trimmed}" existiert bereits.`,
      );
    }
    return tx
      .insert(schema.members)
      .values({ name: trimmed, color: "" })
      .returning()
      .get();
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
        `Ein Mitglied mit dem Namen "${trimmed}" existiert bereits.`,
      );
    }
    tx.update(schema.members).set({ name: trimmed }).where(eq(schema.members.id, id)).run();
    return tx.select().from(schema.members).where(eq(schema.members.id, id)).get()!;
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
    throw AppError.badRequest("Der Tag-Name darf nicht leer sein.");
  }
  const existing = db
    .select()
    .from(schema.tags)
    .where(eq(schema.tags.name, trimmed))
    .get();
  if (existing) {
    if (existing.kind !== kind) {
      throw AppError.conflict(
        `Der Tag „${trimmed}“ existiert bereits als anderer Typ. Ändere den Typ zuerst in der Tag-Verwaltung.`,
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
    throw AppError.notFound(`Tag mit ID ${id} wurde nicht gefunden.`);
  }
  const patch: Partial<typeof schema.tags.$inferInsert> = {};
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed === "") {
      throw AppError.badRequest("Der Tag-Name darf nicht leer sein.");
    }
    const existing = db
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.name, trimmed))
      .get();
    if (existing && existing.id !== id) {
      throw AppError.conflict(`Der Tag „${trimmed}“ existiert bereits.`);
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
    throw AppError.notFound(`Tag mit ID ${id} wurde nicht gefunden.`);
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
    throw AppError.notFound(`Projekt mit ID ${id} wurde nicht gefunden.`);
  }
  return project;
}

/**
 * New stories always start in `backlog` unless a status is explicitly
 * requested (used by fixtures/tests and direct API creation) — there is no
 * driver requirement at creation time itself, only when a story is
 * explicitly *activated* via {@link activateProject} (see below).
 */
export function createProject(db: Db, input: CreateProjectInput) {
  if (!input.title || input.title.trim() === "") {
    throw AppError.badRequest("Der Projekttitel darf nicht leer sein.");
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
export function updateProject(db: Db, id: number, input: UpdateProjectInput) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    if (input.title !== undefined && input.title.trim() === "") {
      throw AppError.badRequest("Der Projekttitel darf nicht leer sein.");
    }
    if (input.ownerMemberId === null && project.status !== "backlog") {
      throw AppError.conflict(
        `Die verantwortliche Person von "${project.title}" kann erst entfernt werden, wenn das Projekt wieder auf „Später / noch nicht aktiv“ steht.`,
      );
    }
    const patch: Partial<typeof schema.projects.$inferInsert> = {
      updatedAt: nowIso(),
    };
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.ownerMemberId !== undefined) patch.ownerMemberId = input.ownerMemberId;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.scheduledDate !== undefined) patch.scheduledDate = input.scheduledDate;
    if (input.position !== undefined) patch.position = input.position;

    tx.update(schema.projects).set(patch).where(eq(schema.projects.id, id)).run();

    if (input.tagIds !== undefined) {
      tx.delete(schema.projectTags)
        .where(eq(schema.projectTags.projectId, id))
        .run();
      for (const tagId of input.tagIds) {
        tx.insert(schema.projectTags).values({ projectId: id, tagId }).run();
      }
    }
    return tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
  });
}

/**
 * Permanently removes a project while preserving its tasks. The projects FK
 * uses ON DELETE SET NULL for tasks, while project tags and completion
 * criteria cascade with the deleted project.
 */
export function deleteProject(db: Db, id: number) {
  getProjectOrThrow(db, id);
  db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
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
  project: { title: string; status: string },
  action: ProjectWorkflowAction,
  conflictMessage: string,
) {
  const status = project.status as ProjectStatus;
  if (!availableProjectWorkflowActions(status).includes(action)) {
    throw AppError.conflict(conflictMessage);
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
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(
      project,
      "activate",
      `Projekt "${project.title}" kann aus dem Status "${project.status}" nicht aktiviert werden.`,
    );
    const ownerMemberId =
      input.ownerMemberId !== undefined ? input.ownerMemberId : project.ownerMemberId;
    if (ownerMemberId === null) {
      throw AppError.badRequest(
        `Bevor "${project.title}" aktiv werden kann, muss eine verantwortliche Person zugewiesen werden.`,
      );
    }
    tx.update(schema.projects)
      .set({ status: "active", ownerMemberId, updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    return tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
  });
}

/**
 * `active`/`archived` -> `backlog`. The only way for a story to reach a
 * state where its driver may be cleared again.
 */
export function returnProjectToBacklog(db: Db, id: number) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(
      project,
      "return_to_backlog",
      `Projekt "${project.title}" kann aus dem Status "${project.status}" nicht auf „Später / noch nicht aktiv“ verschoben werden.`,
    );
    tx.update(schema.projects)
      .set({ status: "backlog", updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    return tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
  });
}

/**
 * `active` -> `completed`. Always a deliberate, manual decision: nothing
 * auto-completes a story just because every task is done/cancelled — that
 * situation only ever surfaces as the `completion_review` stuck reason,
 * prompting a human to call this action (or {@link reopenProject}/
 * {@link archiveProject} instead).
 */
export function completeProject(db: Db, id: number) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(
      project,
      "complete",
      `Nur aktive Projekte können abgeschlossen werden (aktueller Status von "${project.title}": "${project.status}").`,
    );
    tx.update(schema.projects)
      .set({ status: "completed", updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    return tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
  });
}

/** `completed` -> `active` again. The driver is retained unchanged. */
export function reopenProject(db: Db, id: number) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(
      project,
      "reopen",
      `Nur abgeschlossene Projekte können wieder geöffnet werden (aktueller Status von "${project.title}": "${project.status}").`,
    );
    tx.update(schema.projects)
      .set({ status: "active", updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    return tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
  });
}

/**
 * `backlog`/`active`/`completed` -> `archived`. Shelves/retires a story
 * without touching its driver.
 */
export function archiveProject(db: Db, id: number) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const project = getProjectOrThrow(txDb, id);
    assertWorkflowAction(
      project,
      "archive",
      `Projekt "${project.title}" ist bereits archiviert.`,
    );
    tx.update(schema.projects)
      .set({ status: "archived", updatedAt: nowIso() })
      .where(eq(schema.projects.id, id))
      .run();
    return tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
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
      `Der „Erledigt, wenn …“-Punkt mit ID ${criterionId} wurde im Projekt ${projectId} nicht gefunden.`,
    );
  }
  return criterion;
}

function normalizeCriterionText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw AppError.badRequest(
      "Der Text für „Erledigt, wenn …“ darf nicht leer sein.",
    );
  }
  return trimmed;
}

/** Appends a new criterion at the end of the project's ordered list. */
export function addCriterion(db: Db, projectId: number, text: string) {
  const trimmed = normalizeCriterionText(text);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getProjectOrThrow(txDb, projectId);
    const maxPosition = tx
      .select({ position: schema.projectAcceptanceCriteria.position })
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.projectId, projectId))
      .all()
      .reduce((max, c) => Math.max(max, c.position), -1);
    return tx
      .insert(schema.projectAcceptanceCriteria)
      .values({ projectId, text: trimmed, position: maxPosition + 1 })
      .returning()
      .get();
  });
}

/** Edits a criterion's text without changing its position/checked state. */
export function updateCriterionText(
  db: Db,
  projectId: number,
  criterionId: number,
  text: string,
) {
  const trimmed = normalizeCriterionText(text);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getProjectOrThrow(txDb, projectId);
    getCriterionOrThrow(txDb, projectId, criterionId);
    tx.update(schema.projectAcceptanceCriteria)
      .set({ text: trimmed, updatedAt: nowIso() })
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .run();
    return tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .get()!;
  });
}

/** Checks/unchecks a single criterion (completion itself stays manual). */
export function setCriterionChecked(
  db: Db,
  projectId: number,
  criterionId: number,
  checked: boolean,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getProjectOrThrow(txDb, projectId);
    getCriterionOrThrow(txDb, projectId, criterionId);
    tx.update(schema.projectAcceptanceCriteria)
      .set({ checked, updatedAt: nowIso() })
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .run();
    return tx
      .select()
      .from(schema.projectAcceptanceCriteria)
      .where(eq(schema.projectAcceptanceCriteria.id, criterionId))
      .get()!;
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
        "Die Reihenfolge muss genau die vorhandenen „Erledigt, wenn …“-Punkte des Projekts enthalten.",
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
export function removeCriterion(db: Db, projectId: number, criterionId: number) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getProjectOrThrow(txDb, projectId);
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
  });
}

// ---------------------------------------------------------------------------
// Task read helpers
// ---------------------------------------------------------------------------

export function getTaskOrThrow(db: Db, id: number) {
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!task) {
    throw AppError.notFound(`Aufgabe mit ID ${id} wurde nicht gefunden.`);
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
    throw AppError.badRequest("Der Aufgabentitel darf nicht leer sein.");
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

  const task = db
    .insert(schema.tasks)
    .values({
      projectId,
      parentTaskId,
      title: input.title.trim(),
      notes: input.notes ?? "",
      status: input.status ?? "actionable",
      needsClarification:
        input.needsClarification ??
        (input.status === undefined &&
          projectId === null &&
          parentTaskId === null),
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

export function createTask(db: Db, input: CreateTaskInput) {
  return db.transaction((tx) => {
    return insertTask(tx as unknown as Db, input);
  });
}

export function createChildTask(
  db: Db,
  parentTaskId: number,
  input: Omit<CreateTaskInput, "parentTaskId" | "projectId">,
) {
  getTaskOrThrow(db, parentTaskId);
  return createTask(db, { ...input, parentTaskId });
}

export interface CreateTaskSequenceInput {
  titles: string[];
  createdByMemberId?: number | null;
}

function normalizedSequenceTitles(titles: string[]): string[] {
  const normalized = titles.map((title) => title.trim()).filter(Boolean);
  if (normalized.length < 2) {
    throw AppError.badRequest(
      "Ein Ablauf braucht mindestens zwei benannte Schritte.",
    );
  }
  return normalized;
}

/** Creates a self-contained top-level project chain atomically. */
export function createProjectTaskSequence(
  db: Db,
  projectId: number,
  input: CreateTaskSequenceInput,
) {
  const titles = normalizedSequenceTitles(input.titles);
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getProjectOrThrow(txDb, projectId);
    const created: ReturnType<typeof insertTask>[] = [];

    for (const title of titles) {
      const task = insertTask(txDb, {
        projectId,
        title,
        status: "actionable",
        needsClarification: false,
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

    return created;
  });
}

/** Creates one sibling immediately downstream of an existing task. */
export function createTaskSuccessor(
  db: Db,
  taskId: number,
  input: Omit<CreateTaskInput, "parentTaskId" | "projectId">,
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
      projectId: predecessor.projectId,
      parentTaskId: predecessor.parentTaskId,
      status: input.status ?? "actionable",
      needsClarification: input.needsClarification ?? false,
    }, successorPosition);
    tx
      .insert(schema.taskDependencies)
      .values({ taskId: successor.id, dependsOnTaskId: predecessor.id })
      .run();
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

export function updateTask(db: Db, id: number, input: UpdateTaskInput) {
  return db.transaction((tx) => {
    getTaskOrThrow(tx as unknown as Db, id);
    if (input.title !== undefined && input.title.trim() === "") {
      throw AppError.badRequest("Der Aufgabentitel darf nicht leer sein.");
    }
    const patch: Partial<typeof schema.tasks.$inferInsert> = {
      updatedAt: nowIso(),
    };
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.status !== undefined) patch.status = input.status;
    if (input.needsClarification !== undefined) {
      patch.needsClarification = input.needsClarification;
    } else if (input.status !== undefined) {
      patch.needsClarification = false;
    }
    if (input.ownerMemberId !== undefined) patch.ownerMemberId = input.ownerMemberId;
    if (input.ownerInheritanceMode !== undefined)
      patch.ownerInheritanceMode = input.ownerInheritanceMode;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.scheduledDate !== undefined) patch.scheduledDate = input.scheduledDate;
    if (input.waitingFor !== undefined) patch.waitingFor = input.waitingFor;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.size !== undefined) patch.size = input.size;
    if (input.recurrenceRule !== undefined) patch.recurrenceRule = input.recurrenceRule;
    if (input.reminderAt !== undefined) patch.reminderAt = input.reminderAt;

    tx.update(schema.tasks).set(patch).where(eq(schema.tasks.id, id)).run();

    if (input.tagIds !== undefined) {
      tx.delete(schema.taskTags).where(eq(schema.taskTags.taskId, id)).run();
      for (const tagId of input.tagIds) {
        tx.insert(schema.taskTags).values({ taskId: id, tagId }).run();
      }
    }
    if (input.excludedTagIds !== undefined) {
      tx.delete(schema.taskExcludedTags)
        .where(eq(schema.taskExcludedTags.taskId, id))
        .run();
      for (const tagId of input.excludedTagIds) {
        tx.insert(schema.taskExcludedTags).values({ taskId: id, tagId }).run();
      }
    }
    return tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
  });
}

export function deleteTask(db: Db, id: number) {
  getTaskOrThrow(db, id);
  // ON DELETE CASCADE (foreign_keys=ON) takes care of descendants and any
  // dependency rows that reference this task in either direction.
  db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
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
) {
  return db.transaction((tx) => {
    getTaskOrThrow(tx as unknown as Db, id);
    const openChildren = openDescendants(tx as unknown as Db, id);
    if (openChildren.length > 0 && descendantsPolicy === undefined) {
      throw new AppError(
        409,
        "descendants_policy_required",
        "Diese Aufgabe hat offene Teilaufgaben. Bitte wähle, ob sie ebenfalls erledigt werden sollen.",
        {
          openChildrenCount: openChildren.length,
          options: ["leave_open", "complete_children"],
        },
      );
    }
    const now = nowIso();
    tx.update(schema.tasks)
      .set({
        status: "done",
        needsClarification: false,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.tasks.id, id))
      .run();

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
    return tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
  });
}

export function cancelTask(
  db: Db,
  id: number,
  descendantsPolicy?: CancelDescendantsPolicy,
) {
  return db.transaction((tx) => {
    getTaskOrThrow(tx as unknown as Db, id);
    const openChildren = openDescendants(tx as unknown as Db, id);
    if (openChildren.length > 0 && descendantsPolicy === undefined) {
      throw new AppError(
        409,
        "descendants_policy_required",
        "Diese Aufgabe hat offene Teilaufgaben. Bitte wähle, ob sie ebenfalls verworfen werden sollen.",
        {
          openChildrenCount: openChildren.length,
          options: ["leave_open", "cancel_children"],
        },
      );
    }
    const now = nowIso();
    tx.update(schema.tasks)
      .set({
        status: "cancelled",
        needsClarification: false,
        cancelledAt: now,
        updatedAt: now,
      })
      .where(eq(schema.tasks.id, id))
      .run();

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
    return tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
  });
}

export function reopenTask(db: Db, id: number) {
  return db.transaction((tx) => {
    getTaskOrThrow(tx as unknown as Db, id);
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
    return tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
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
export function moveTask(db: Db, taskId: number, input: MoveTaskInput) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const task = getTaskOrThrow(txDb, taskId);

    const newParentTaskId =
      "parentTaskId" in input ? input.parentTaskId ?? null : task.parentTaskId;

    let newProjectId: number | null;
    if (newParentTaskId !== null) {
      if (newParentTaskId === taskId) {
        throw AppError.conflict(
          "Eine Aufgabe kann nicht ihr eigenes übergeordnetes Element sein.",
        );
      }
      const newParent = getTaskOrThrow(txDb, newParentTaskId);
      if (wouldCreateHierarchyCycle(txDb, taskId, newParentTaskId)) {
        throw AppError.conflict(
          "Diese Verschiebung würde einen Kreis in der Aufgabenhierarchie erzeugen.",
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

    return tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
  });
}

export function reorderTask(db: Db, taskId: number, position: number) {
  return moveTask(db, taskId, { position });
}

export function changeTaskParent(
  db: Db,
  taskId: number,
  parentTaskId: number | null,
  projectId?: number | null,
) {
  const input: MoveTaskInput = { parentTaskId };
  if (parentTaskId === null && projectId !== undefined) {
    input.projectId = projectId;
  }
  return moveTask(db, taskId, input);
}

export function moveSubtreeToProject(
  db: Db,
  taskId: number,
  targetProjectId: number | null,
) {
  return moveTask(db, taskId, { parentTaskId: null, projectId: targetProjectId });
}

export function indentTask(db: Db, taskId: number) {
  const task = getTaskOrThrow(db, taskId);
  const siblings = siblingsOf(db, task.parentTaskId, task.projectId, -1)
    .concat()
    .sort((a, b) => a.position - b.position);
  const currentIndex = siblings.findIndex((t) => t.id === taskId);
  if (currentIndex <= 0) {
    throw AppError.badRequest(
      "Es gibt keine vorherige gleichrangige Aufgabe, unter die eingerückt werden kann.",
    );
  }
  const previousSibling = siblings[currentIndex - 1]!;
  return moveTask(db, taskId, { parentTaskId: previousSibling.id });
}

export function outdentTask(db: Db, taskId: number) {
  const task = getTaskOrThrow(db, taskId);
  if (task.parentTaskId === null) {
    throw AppError.badRequest(
      "Diese Aufgabe ist bereits oberste Ebene und kann nicht weiter ausgerückt werden.",
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
  return moveTask(db, taskId, input);
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export function addDependency(db: Db, taskId: number, dependsOnTaskId: number) {
  if (taskId === dependsOnTaskId) {
    throw AppError.conflict("Eine Aufgabe kann nicht von sich selbst abhängen.");
  }
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    getTaskOrThrow(txDb, taskId);
    getTaskOrThrow(txDb, dependsOnTaskId);

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
        "Diese Abhängigkeit würde einen Kreis erzeugen und ist nicht erlaubt.",
      );
    }

    return tx
      .insert(schema.taskDependencies)
      .values({ taskId, dependsOnTaskId })
      .returning()
      .get();
  });
}

export function removeDependency(
  db: Db,
  taskId: number,
  dependsOnTaskId: number,
) {
  db.delete(schema.taskDependencies)
    .where(
      and(
        eq(schema.taskDependencies.taskId, taskId),
        eq(schema.taskDependencies.dependsOnTaskId, dependsOnTaskId),
      ),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Tags on tasks
// ---------------------------------------------------------------------------

export function addTaskTag(db: Db, taskId: number, tagId: number) {
  getTaskOrThrow(db, taskId);
  const existing = db
    .select()
    .from(schema.taskTags)
    .where(and(eq(schema.taskTags.taskId, taskId), eq(schema.taskTags.tagId, tagId)))
    .get();
  if (!existing) {
    db.insert(schema.taskTags).values({ taskId, tagId }).run();
  }
}

export function removeTaskTag(db: Db, taskId: number, tagId: number) {
  db.delete(schema.taskTags)
    .where(and(eq(schema.taskTags.taskId, taskId), eq(schema.taskTags.tagId, tagId)))
    .run();
}

export function addExcludedTag(db: Db, taskId: number, tagId: number) {
  getTaskOrThrow(db, taskId);
  const existing = db
    .select()
    .from(schema.taskExcludedTags)
    .where(
      and(
        eq(schema.taskExcludedTags.taskId, taskId),
        eq(schema.taskExcludedTags.tagId, tagId),
      ),
    )
    .get();
  if (!existing) {
    db.insert(schema.taskExcludedTags).values({ taskId, tagId }).run();
  }
}

export function removeExcludedTag(db: Db, taskId: number, tagId: number) {
  db.delete(schema.taskExcludedTags)
    .where(
      and(
        eq(schema.taskExcludedTags.taskId, taskId),
        eq(schema.taskExcludedTags.tagId, tagId),
      ),
    )
    .run();
}
