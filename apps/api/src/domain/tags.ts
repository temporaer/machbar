/**
 * Tag CRUD and the deterministic tag-color assignment.
 */
import { eq } from "drizzle-orm";
import type { TagGroupingMode, TagKind } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { actor } from "./workItemShared.js";

export function listTags(db: Db) {
  const kindOrder: Record<TagKind, number> = {
    area: 0,
    actor: 1,
    plain: 2,
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
