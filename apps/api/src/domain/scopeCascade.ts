import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { WorkItemScope } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { nowIso } from "./workItemShared.js";

/** Cascade a root scope change without carrying private project drivers into
 * household backlog. Task owners and drivers on non-backlog projects remain. */
export function cascadeDescendantScope(db: Db, descendantIds: number[], scope: WorkItemScope): void {
  if (descendantIds.length === 0) return;
  const ownerlessBacklogProjects = scope === "household"
    ? db.select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(and(
          inArray(schema.workItems.id, descendantIds),
          eq(schema.workItems.role, "story"),
          eq(schema.workItems.status, "backlog"),
          isNull(schema.workItems.archivedAt),
          eq(schema.workItems.scope, "work"),
          isNotNull(schema.workItems.ownerMemberId),
        )).all().map(({ id }) => id)
    : [];
  const ownerlessIds = new Set(ownerlessBacklogProjects);
  const retainedOwnerIds = descendantIds.filter((id) => !ownerlessIds.has(id));
  const updatedAt = nowIso();
  if (retainedOwnerIds.length > 0) {
    db.update(schema.workItems).set({
      scope,
      revision: sql`${schema.workItems.revision} + 1`,
      updatedAt,
    }).where(inArray(schema.workItems.id, retainedOwnerIds)).run();
  }
  if (ownerlessBacklogProjects.length > 0) {
    db.update(schema.workItems).set({
      scope,
      ownerMemberId: null,
      revision: sql`${schema.workItems.revision} + 1`,
      updatedAt,
    }).where(inArray(schema.workItems.id, ownerlessBacklogProjects)).run();
  }
}
