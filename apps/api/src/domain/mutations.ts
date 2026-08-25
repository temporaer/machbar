import { and, eq, inArray } from "drizzle-orm";
import type {
  InheritanceMode,
  ProjectStatus,
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
  return db.select().from(schema.members).all();
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

export function deleteMember(db: Db, id: number) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const member = getMemberOrThrow(txDb, id);

    const ownedProjects = tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerMemberId, id))
      .all();
    const ownedTasks = tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.ownerMemberId, id))
      .all();
    const createdTasks = tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.createdByMemberId, id))
      .all();

    if (ownedProjects.length > 0 || ownedTasks.length > 0 || createdTasks.length > 0) {
      throw AppError.conflict(
        `Mitglied "${member.name}" kann nicht gelöscht werden, solange es noch Projekten oder Aufgaben (als Zuständige/r oder Ersteller/in) zugeordnet ist.`,
      );
    }

    tx.delete(schema.members).where(eq(schema.members.id, id)).run();
  });
}

export function listTags(db: Db) {
  return db.select().from(schema.tags).all();
}

export function getOrCreateTag(db: Db, name: string) {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw AppError.badRequest("Der Tag-Name darf nicht leer sein.");
  }
  const existing = db
    .select()
    .from(schema.tags)
    .where(eq(schema.tags.name, trimmed))
    .get();
  if (existing) return existing;
  return db.insert(schema.tags).values({ name: trimmed }).returning().get();
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  title: string;
  description?: string;
  status?: ProjectStatus;
  ownerMemberId?: number | null;
  context?: string | null;
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
        description: input.description ?? "",
        status: input.status ?? "active",
        ownerMemberId: input.ownerMemberId ?? null,
        context: input.context ?? null,
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
  description?: string;
  status?: ProjectStatus;
  ownerMemberId?: number | null;
  context?: string | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  position?: number;
  tagIds?: number[];
}

export function updateProject(db: Db, id: number, input: UpdateProjectInput) {
  return db.transaction((tx) => {
    getProjectOrThrow(tx as unknown as Db, id);
    if (input.title !== undefined && input.title.trim() === "") {
      throw AppError.badRequest("Der Projekttitel darf nicht leer sein.");
    }
    const patch: Partial<typeof schema.projects.$inferInsert> = {
      updatedAt: nowIso(),
    };
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.description !== undefined) patch.description = input.description;
    if (input.status !== undefined) patch.status = input.status;
    if (input.ownerMemberId !== undefined) patch.ownerMemberId = input.ownerMemberId;
    if (input.context !== undefined) patch.context = input.context;
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

export function archiveProject(db: Db, id: number) {
  return updateProject(db, id, { status: "archived" });
}

export function unarchiveProject(db: Db, id: number) {
  return updateProject(db, id, { status: "active" });
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
  ownerMemberId?: number | null;
  ownerInheritanceMode?: InheritanceMode;
  createdByMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  waitingFor?: string | null;
  context?: string | null;
  contextInheritanceMode?: InheritanceMode;
  priority?: number | null;
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

export function createTask(db: Db, input: CreateTaskInput) {
  if (!input.title || input.title.trim() === "") {
    throw AppError.badRequest("Der Aufgabentitel darf nicht leer sein.");
  }
  return db.transaction((tx) => {
    let projectId = input.projectId ?? null;
    const parentTaskId = input.parentTaskId ?? null;

    if (parentTaskId !== null) {
      const parent = getTaskOrThrow(tx as unknown as Db, parentTaskId);
      projectId = parent.projectId;
    } else if (projectId !== null) {
      getProjectOrThrow(tx as unknown as Db, projectId);
    }

    const position = nextPositionForGroup(
      tx as unknown as Db,
      parentTaskId,
      projectId,
    );

    const task = tx
      .insert(schema.tasks)
      .values({
        projectId,
        parentTaskId,
        title: input.title.trim(),
        notes: input.notes ?? "",
        status: input.status ?? "inbox",
        ownerMemberId: input.ownerMemberId ?? null,
        ownerInheritanceMode: input.ownerInheritanceMode ?? "inherit",
        createdByMemberId: input.createdByMemberId ?? null,
        dueDate: input.dueDate ?? null,
        scheduledDate: input.scheduledDate ?? null,
        waitingFor: input.waitingFor ?? null,
        context: input.context ?? null,
        contextInheritanceMode: input.contextInheritanceMode ?? "inherit",
        priority: input.priority ?? null,
        position,
      })
      .returning()
      .get();

    if (input.tagIds && input.tagIds.length > 0) {
      for (const tagId of input.tagIds) {
        tx.insert(schema.taskTags).values({ taskId: task.id, tagId }).run();
      }
    }
    return task;
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

export interface UpdateTaskInput {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  ownerMemberId?: number | null;
  ownerInheritanceMode?: InheritanceMode;
  dueDate?: string | null;
  scheduledDate?: string | null;
  waitingFor?: string | null;
  context?: string | null;
  contextInheritanceMode?: InheritanceMode;
  priority?: number | null;
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
    if (input.ownerMemberId !== undefined) patch.ownerMemberId = input.ownerMemberId;
    if (input.ownerInheritanceMode !== undefined)
      patch.ownerInheritanceMode = input.ownerInheritanceMode;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.scheduledDate !== undefined) patch.scheduledDate = input.scheduledDate;
    if (input.waitingFor !== undefined) patch.waitingFor = input.waitingFor;
    if (input.context !== undefined) patch.context = input.context;
    if (input.contextInheritanceMode !== undefined)
      patch.contextInheritanceMode = input.contextInheritanceMode;
    if (input.priority !== undefined) patch.priority = input.priority;
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
      .set({ status: "done", completedAt: now, updatedAt: now })
      .where(eq(schema.tasks.id, id))
      .run();

    if (descendantsPolicy === "complete_children") {
      for (const child of openChildren) {
        tx.update(schema.tasks)
          .set({ status: "done", completedAt: now, updatedAt: now })
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
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(eq(schema.tasks.id, id))
      .run();

    if (descendantsPolicy === "cancel_children") {
      for (const child of openChildren) {
        tx.update(schema.tasks)
          .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
          .where(eq(schema.tasks.id, child.id))
          .run();
      }
    }
    return tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
  });
}

export function reopenTask(db: Db, id: number) {
  return db.transaction((tx) => {
    const task = getTaskOrThrow(tx as unknown as Db, id);
    const looksClarified =
      task.projectId !== null ||
      task.context !== null ||
      task.ownerMemberId !== null ||
      task.dueDate !== null ||
      task.scheduledDate !== null;
    const now = nowIso();
    tx.update(schema.tasks)
      .set({
        status: looksClarified ? "actionable" : "inbox",
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
