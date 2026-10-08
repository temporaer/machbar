import type {
  ActivityEntityType,
  ActivityEvent,
  ActivityEventKind,
  ActivityEventMetadata,
  ActivityStateSnapshot,
  ActivityPage,
} from "@machbar/shared";
import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { effectiveOwnerId } from "../domain/workItemShared.js";

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface ActivityFilters {
  cursor?: string;
  limit: number;
  viewerMemberId?: number | null;
  actorId?: number;
  taskId?: number;
  projectId?: number;
}

function visibleToViewer(
  db: Db,
  row: {
    entityId: number | null;
    metadata: unknown;
  },
  viewerMemberId: number | null,
): boolean {
  const metadata = (row.metadata ?? {}) as ActivityEventMetadata;
  let scope = metadata.scope;
  let owner =
    metadata.after?.effectiveOwnerId ??
    metadata.before?.effectiveOwnerId ??
    metadata.after?.ownerMemberId ??
    metadata.before?.ownerMemberId;
  if (scope === undefined && row.entityId !== null) {
    const current = db
      .select({
        role: schema.workItems.role,
        scope: schema.workItems.scope,
        ownerMemberId: schema.workItems.ownerMemberId,
      })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, row.entityId))
      .get();
    scope = current?.scope as "household" | "work" | undefined;
    if (owner === undefined) {
      owner =
        current?.role === "task"
          ? effectiveOwnerId(db, row.entityId)
          : current?.ownerMemberId;
    }
  }
  if (scope === undefined || scope === "household") return true;
  return viewerMemberId !== null && owner === viewerMemberId;
}

interface ActivityCursor {
  createdAt: string;
  id: number;
}

export interface RecordActivityInput {
  actorMemberId?: number | null;
  kind: ActivityEventKind;
  entityType: ActivityEntityType;
  entityTitle: string;
  taskId?: number | null;
  projectId?: number | null;
  metadata?: ActivityEventMetadata;
}

function activityContext(
  db: Db,
  workItemId: number | null,
): {
  scope?: "household" | "work";
  projectContextId?: number | null;
  snapshot?: ActivityStateSnapshot;
} {
  if (workItemId === null) return {};
  const row = db
    .select({
      id: schema.workItems.id,
      parentId: schema.workItems.parentId,
      role: schema.workItems.role,
      ownerMemberId: schema.workItems.ownerMemberId,
      scope: schema.workItems.scope,
      dueDate: schema.workItems.dueDate,
      scheduledDate: schema.workItems.scheduledDate,
      notBeforeAt: schema.workItems.notBeforeAt,
      notBeforeDate: schema.workItems.notBeforeDate,
      taskKind: schema.workItems.taskKind,
    })
    .from(schema.workItems)
    .where(eq(schema.workItems.id, workItemId))
    .get();
  if (!row) return {};

  let projectContextId: number | null =
    row.role === "story" ? row.id : null;
  let parentId = row.parentId;
  for (let depth = 0; projectContextId === null && parentId !== null && depth < 100; depth += 1) {
    const parent = db
      .select({
        id: schema.workItems.id,
        parentId: schema.workItems.parentId,
        role: schema.workItems.role,
      })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, parentId))
      .get();
    if (!parent) break;
    if (parent.role === "story") projectContextId = parent.id;
    parentId = parent.parentId;
  }

  return {
    scope: row.scope as "household" | "work",
    projectContextId,
    snapshot: {
      ownerMemberId: row.ownerMemberId,
      effectiveOwnerId:
        row.role === "task" ? effectiveOwnerId(db, workItemId) : row.ownerMemberId,
      dueDate: row.dueDate,
      scheduledDate: row.scheduledDate,
      notBeforeAt: row.notBeforeAt,
      notBeforeDate: row.notBeforeDate,
      taskKind: row.taskKind === null ? undefined : row.taskKind as "action" | "reference",
      projectId: projectContextId,
    },
  };
}

/** Inserts an activity event using the caller's transaction-bound database. */
export function recordActivity(db: Db, input: RecordActivityInput): number {
  const entityId = input.taskId ?? input.projectId ?? null;
  const context = activityContext(db, entityId);
  const metadata: ActivityEventMetadata = {
    ...(input.metadata ?? {}),
    ...(context.scope !== undefined && input.metadata?.scope === undefined
      ? { scope: context.scope }
      : {}),
    ...(input.metadata?.projectContextId === undefined
      ? { projectContextId: context.projectContextId ?? null }
      : {}),
    ...(input.metadata?.affectedWorkItemId === undefined && entityId !== null
      ? { affectedWorkItemId: entityId }
      : {}),
    ...(input.metadata?.affectedEntityType === undefined
      ? { affectedEntityType: input.entityType }
      : {}),
    ...(context.snapshot || input.metadata?.after
      ? {
          after: {
            ...(context.snapshot ?? {}),
            ...(input.metadata?.after ?? {}),
          },
        }
      : {}),
  };
  return db.insert(schema.activityEvents)
    .values({
      actorMemberId: input.actorMemberId ?? null,
      kind: input.kind,
      entityType: input.entityType,
      entityTitle: input.entityTitle,
      entityId,
      metadata,
    })
    .returning({ id: schema.activityEvents.id })
    .get().id;
}

function encodeCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): ActivityCursor {
  try {
    if (!CURSOR_PATTERN.test(value)) throw new Error("invalid encoding");
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("non-canonical encoding");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).length !== 2 ||
      !("createdAt" in parsed) ||
      !("id" in parsed) ||
      typeof parsed.createdAt !== "string" ||
      !ISO_TIMESTAMP_PATTERN.test(parsed.createdAt) ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "number" ||
      !Number.isSafeInteger(parsed.id) ||
      parsed.id <= 0
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw AppError.badRequest(
      "activity_cursor_invalid",
      "The activity cursor is invalid.",
      { cursor: value },
    );
  }
}

/**
 * Returns a stable newest-first page. The cursor contains both ordering
 * columns, so events sharing a timestamp cannot be skipped or repeated.
 */
export function getActivityPage(
  db: Db,
  filters: ActivityFilters,
): ActivityPage {
  const conditions: SQL[] = [];
  if (filters.actorId !== undefined) {
    conditions.push(eq(schema.activityEvents.actorMemberId, filters.actorId));
  }
  if (filters.taskId !== undefined) {
    conditions.push(eq(schema.activityEvents.entityId, filters.taskId));
  }
  if (filters.projectId !== undefined) {
    const descendantRows = db.all<{ id: number }>(sql`
      WITH RECURSIVE descendants(id) AS (
        SELECT ${filters.projectId}
        UNION ALL
        SELECT child.id
        FROM work_items child
        JOIN descendants d ON child.parent_id = d.id
      )
      SELECT id FROM descendants
    `);
    const ids = descendantRows.map((row) => row.id);
    conditions.push(inArray(schema.activityEvents.entityId, ids));
  }
  if (filters.cursor !== undefined) {
    const cursor = decodeCursor(filters.cursor);
    conditions.push(
      or(
        lt(schema.activityEvents.createdAt, cursor.createdAt),
        and(
          eq(schema.activityEvents.createdAt, cursor.createdAt),
          lt(schema.activityEvents.id, cursor.id),
        ),
      )!,
    );
  }

  const rows = db
    .select({
      id: schema.activityEvents.id,
      createdAt: schema.activityEvents.createdAt,
      kind: schema.activityEvents.kind,
      entityId: schema.activityEvents.entityId,
      entityType: schema.activityEvents.entityType,
      entityTitle: schema.activityEvents.entityTitle,
      metadata: schema.activityEvents.metadata,
      actorId: schema.members.id,
      actorName: schema.members.name,
      actorColor: schema.members.color,
      actorPictureUrl: schema.memberOidcIdentities.pictureUrl,
    })
    .from(schema.activityEvents)
    .leftJoin(
      schema.members,
      eq(schema.activityEvents.actorMemberId, schema.members.id),
    )
    .leftJoin(
      schema.memberOidcIdentities,
      eq(schema.members.id, schema.memberOidcIdentities.memberId),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      desc(schema.activityEvents.createdAt),
      desc(schema.activityEvents.id),
    )
    .limit(filters.viewerMemberId === undefined ? filters.limit + 1 : 1_000_000)
    .all();
  const visibleRows =
    filters.viewerMemberId === undefined
      ? rows
      : rows.filter((row) => visibleToViewer(db, row, filters.viewerMemberId ?? null));

  const hasMore = visibleRows.length > filters.limit;
  const pageRows = hasMore ? visibleRows.slice(0, filters.limit) : visibleRows;
  const items: ActivityEvent[] = pageRows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    kind: row.kind,
    actor:
      row.actorId !== null &&
      row.actorName !== null &&
      row.actorColor !== null
        ? {
            id: row.actorId,
            name: row.actorName,
            color: row.actorColor,
            pictureUrl: row.actorPictureUrl ?? null,
          }
        : null,
    entity: {
      type: row.entityType,
      title: row.entityTitle,
      taskId: row.entityType === "task" ? row.entityId : null,
      projectId: row.entityType === "project" ? row.entityId : null,
    },
    metadata: row.metadata as ActivityEventMetadata,
  }));
  const last = pageRows.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}
