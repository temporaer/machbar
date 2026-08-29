import type {
  Member,
  ProjectStatus,
  TaskSize,
  TaskStatus,
} from "@machbar/shared";
import { taskSizes } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { isTaskInWorkingSystem } from "../domain/workEligibility.js";
import { getEffectiveOwners, getEffectiveTagIds } from "./effectiveRepo.js";

/**
 * "Open" work for refinement purposes: everything that isn't finished or
 * discarded. This mirrors the same `status NOT IN ('done', 'cancelled')`
 * rule used by the stuck-project classification in `stuckRepo.ts`.
 */
function isOpenStatus(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled";
}

export interface RefinementFilters {
  /** Filter to tasks whose *effective* owner matches this member id, or
   * `null` to filter to the shared/unassigned bucket (effective owner id
   * is `null`). Leave undefined for no owner filter. */
  ownerId?: number | null;
  /** Filter to tasks directly assigned to this project (not inherited). */
  projectId?: number;
  /** Require every listed effective tag. */
  tagIds?: number[];
}

export interface OwnerSizeCounts {
  /** `null` represents the shared/unassigned bucket (no effective owner). */
  ownerId: number | null;
  ownerName: string | null;
  S: number;
  M: number;
  L: number;
  XL: number;
  unestimated: number;
  total: number;
}

export interface RefinementTaskRow {
  id: number;
  title: string;
  status: TaskStatus;
  size: TaskSize | null;
  projectId: number | null;
  projectTitle: string | null;
  effectiveOwnerId: number | null;
  effectiveOwnerSource: "task" | "parent" | "project" | "none";
  position: number;
  updatedAt: string;
}

interface OpenTaskRow {
  id: number;
  revision: number;
  title: string;
  status: TaskStatus;
  size: TaskSize | null;
  projectId: number | null;
  position: number;
  updatedAt: string;
}

/**
 * Loads every open task together with its effective owner, applying the
 * optional owner/project filters shared by both refinement queries below.
 * Owner resolution reuses `getEffectiveOwners`'s recursive CTE
 * rather than re-deriving inheritance here, so a task reassigned or moved
 * between projects/parents is picked up automatically the next time this
 * is called (there is no cached/denormalized owner to go stale).
 */
function loadFilteredOpenTasks(
  db: Db,
  filters?: RefinementFilters,
): {
  rows: OpenTaskRow[];
  effectiveOwnerId: Map<number, number | null>;
  effectiveOwnerSource: Map<
    number,
    "task" | "parent" | "project" | "none"
  >;
} {
  const effective = getEffectiveOwners(db);
  const effectiveTagIds = getEffectiveTagIds(db);
  const projectStatusById = new Map(
    db
      .select({ id: schema.projects.id, status: schema.projects.status })
      .from(schema.projects)
      .all()
      .map((project) => [
        project.id,
        project.status as ProjectStatus,
      ]),
  );
  const allTasks = db
    .select({
      id: schema.tasks.id,
      revision: schema.tasks.revision,
      title: schema.tasks.title,
      status: schema.tasks.status,
      size: schema.tasks.size,
      projectId: schema.tasks.projectId,
      position: schema.tasks.position,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .all() as OpenTaskRow[];

  const effectiveOwnerId = new Map<number, number | null>();
  const effectiveOwnerSource = new Map<
    number,
    "task" | "parent" | "project" | "none"
  >();
  for (const row of allTasks) {
    const eff = effective.get(row.id);
    effectiveOwnerId.set(row.id, eff?.ownerId ?? null);
    effectiveOwnerSource.set(row.id, eff?.ownerSource ?? "none");
  }

  const rows = allTasks.filter((t) => {
    if (!isOpenStatus(t.status)) return false;
    if (!isTaskInWorkingSystem(t, projectStatusById)) return false;
    if (filters?.projectId !== undefined && t.projectId !== filters.projectId) {
      return false;
    }
    if (filters?.ownerId !== undefined) {
      const ownerId = effectiveOwnerId.get(t.id) ?? null;
      if (ownerId !== filters.ownerId) return false;
    }
    if (filters?.tagIds?.length) {
      const owned = new Set(effectiveTagIds.get(t.id) ?? []);
      if (!filters.tagIds.every((tagId) => owned.has(tagId))) return false;
    }
    return true;
  });

  return { rows, effectiveOwnerId, effectiveOwnerSource };
}

function emptyCounts(ownerId: number | null, ownerName: string | null): OwnerSizeCounts {
  return {
    ownerId,
    ownerName,
    S: 0,
    M: 0,
    L: 0,
    XL: 0,
    unestimated: 0,
    total: 0,
  };
}

/**
 * Aggregates open tasks (excluding `done`/`cancelled`) by effective owner
 * and by `S`/`M`/`L`/`XL`/unestimated size, for the refinement owner×size
 * matrix. Every household member is always represented (even with all-zero
 * counts) alongside one trailing `null`-owner row for shared/unassigned
 * open work, so the UI never needs to synthesize missing rows itself.
 */
export function getRefinementOwnerSizeCounts(
  db: Db,
  filters?: RefinementFilters,
): OwnerSizeCounts[] {
  const members = db.select().from(schema.members).all();
  const { rows, effectiveOwnerId } = loadFilteredOpenTasks(db, filters);

  const countsByOwner = new Map<number | null, OwnerSizeCounts>();
  for (const member of members) {
    countsByOwner.set(member.id, emptyCounts(member.id, member.name));
  }
  countsByOwner.set(null, emptyCounts(null, null));

  for (const row of rows) {
    const ownerId = effectiveOwnerId.get(row.id) ?? null;
    let bucket = countsByOwner.get(ownerId);
    if (!bucket) {
      // Owner referenced by a task but no longer a member row (shouldn't
      // normally happen since owner FKs are ON DELETE SET NULL) — still
      // account for it defensively rather than dropping the task's count.
      bucket = emptyCounts(ownerId, null);
      countsByOwner.set(ownerId, bucket);
    }
    if (row.size && (taskSizes as readonly string[]).includes(row.size)) {
      bucket[row.size as TaskSize] += 1;
    } else {
      bucket.unestimated += 1;
    }
    bucket.total += 1;
  }

  const memberRows = members
    .map((m) => countsByOwner.get(m.id)!)
    .sort((a, b) => (a.ownerName ?? "").localeCompare(b.ownerName ?? ""));
  const sharedRow = countsByOwner.get(null)!;
  const extraRows = [...countsByOwner.entries()]
    .filter(([ownerId]) => ownerId !== null && !members.some((m) => m.id === ownerId))
    .map(([, counts]) => counts);

  return [...memberRows, ...extraRows, sharedRow];
}

/**
 * Lists individual open task rows for the refinement view, with effective
 * owner/size/project already resolved, and the same optional owner/project
 * filters as `getRefinementOwnerSizeCounts`. Ordered by project then
 * sibling `position` so a project's tasks stay grouped and stably ordered.
 */
export function getRefinementTasks(
  db: Db,
  filters?: RefinementFilters,
): RefinementTaskRow[] {
  const projects = db
    .select({ id: schema.projects.id, title: schema.projects.title })
    .from(schema.projects)
    .all();
  const projectTitleById = new Map(projects.map((p) => [p.id, p.title]));

  const { rows, effectiveOwnerId, effectiveOwnerSource } = loadFilteredOpenTasks(
    db,
    filters,
  );

  return rows
    .map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      size: row.size,
      projectId: row.projectId,
      projectTitle: row.projectId !== null ? projectTitleById.get(row.projectId) ?? null : null,
      effectiveOwnerId: effectiveOwnerId.get(row.id) ?? null,
      effectiveOwnerSource: effectiveOwnerSource.get(row.id) ?? "none",
      position: row.position,
      updatedAt: row.updatedAt,
    }))
    .sort((a, b) => {
      const aProject = a.projectId ?? Number.MAX_SAFE_INTEGER;
      const bProject = b.projectId ?? Number.MAX_SAFE_INTEGER;
      if (aProject !== bProject) return aProject - bProject;
      return a.position - b.position;
    });
}
