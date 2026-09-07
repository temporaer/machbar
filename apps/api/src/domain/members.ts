/**
 * Household member CRUD.
 */
import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { nowIso } from "./workItemShared.js";

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
 * Deletes a household member unless they still drive an active project.
 * Other project/task references to the member (as owner, and for tasks also
 * as creator) are cleared to `null` first, in the same transaction as the
 * deletion itself, so projects and tasks are always preserved — deleting a
 * member never cascades into deleting their work. For tasks whose
 * owner-inheritance mode is
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
    const activeProjects = tx
      .select({ id: schema.workItems.id, title: schema.workItems.title })
      .from(schema.workItems)
      .where(
        and(
          eq(schema.workItems.role, "story"),
          eq(schema.workItems.ownerMemberId, id),
          eq(schema.workItems.status, "active"),
        ),
      )
      .all();
    if (activeProjects.length > 0) {
      throw AppError.conflict(
        "member_active_projects_conflict",
        "Reassign or park active projects before deleting their driver.",
        {
          memberId: id,
          projectIds: activeProjects.map((project) => project.id),
          projectTitles: activeProjects.map((project) => project.title),
        },
      );
    }

    const now = nowIso();
    tx.update(schema.workItems)
      .set({
        ownerMemberId: null,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(schema.workItems.role, "story"), eq(schema.workItems.ownerMemberId, id)))
      .run();
    tx.update(schema.workItems)
      .set({
        ownerMemberId: null,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(schema.workItems.role, "task"), eq(schema.workItems.ownerMemberId, id)))
      .run();
    tx.update(schema.workItems)
      .set({
        createdByMemberId: null,
        revision: sql`${schema.workItems.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(schema.workItems.role, "task"), eq(schema.workItems.createdByMemberId, id)))
      .run();

    tx.delete(schema.members).where(eq(schema.members.id, id)).run();
  });
}
