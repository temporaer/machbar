import type {
  ActivityEntityType,
  ActivityEvent,
  ActivityEventKind,
  ActivityEventMetadata,
  ActivityPage,
} from "@machbar/shared";
import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface ActivityFilters {
  cursor?: string;
  limit: number;
  actorId?: number;
  taskId?: number;
  projectId?: number;
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

/** Inserts an activity event using the caller's transaction-bound database. */
export function recordActivity(db: Db, input: RecordActivityInput): number {
  const entityId = input.taskId ?? input.projectId ?? null;
  return db.insert(schema.activityEvents)
    .values({
      actorMemberId: input.actorMemberId ?? null,
      kind: input.kind,
      entityType: input.entityType,
      entityTitle: input.entityTitle,
      entityId,
      metadata: input.metadata ?? {},
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
    .limit(filters.limit + 1)
    .all();

  const hasMore = rows.length > filters.limit;
  const pageRows = hasMore ? rows.slice(0, filters.limit) : rows;
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
