import type {
  ActivityEntityType,
  ActivityEvent,
  ActivityEventKind,
  ActivityEventMetadata,
  ActivityPage,
} from "@machbar/shared";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
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
export function recordActivity(db: Db, input: RecordActivityInput): void {
  db.insert(schema.activityEvents)
    .values({
      actorMemberId: input.actorMemberId ?? null,
      kind: input.kind,
      entityType: input.entityType,
      entityTitle: input.entityTitle,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      metadata: input.metadata ?? {},
    })
    .run();
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
    conditions.push(eq(schema.activityEvents.taskId, filters.taskId));
  }
  if (filters.projectId !== undefined) {
    // Task events record their project context in this same column, so this
    // includes both project events and task events captured in the project.
    conditions.push(eq(schema.activityEvents.projectId, filters.projectId));
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
      taskId: schema.activityEvents.taskId,
      projectId: schema.activityEvents.projectId,
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
      taskId: row.taskId,
      projectId: row.projectId,
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
