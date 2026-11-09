import { asc, eq } from "drizzle-orm";
import type { IntakeDraft, IntakeRecord } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { workItemVisibleToViewer } from "../domain/workItemVisibility.js";
import { AppError } from "../errors.js";

export const INTAKE_PROJECT_INDEX_MAX_BYTES = 16 * 1024;

export function intakeExistingProjects(db: Db, scope: string, viewerMemberId: number | null) {
  return db.select({
    id: schema.workItems.id, title: schema.workItems.title, status: schema.workItems.status,
    revision: schema.workItems.revision, role: schema.workItems.role, scope: schema.workItems.scope,
    ownerMemberId: schema.workItems.ownerMemberId, privacyOwnerMemberId: schema.workItems.privacyOwnerMemberId,
    archivedAt: schema.workItems.archivedAt,
  }).from(schema.workItems).where(eq(schema.workItems.role, "story"))
    .orderBy(asc(schema.workItems.id)).all()
    .filter((row) => row.scope === scope && row.archivedAt === null &&
      (row.status === "active" || row.status === "backlog") &&
      workItemVisibleToViewer(row, viewerMemberId ?? undefined))
    .map(({ id, title, status, revision }) => ({
      id, title, status: status as "active" | "backlog", revision,
    }));
}

/** UTF-8 bound covers the complete serialized envelope, not characters or rows. */
export function intakeProjectIndex(projects: NonNullable<IntakeRecord["existingProjects"]>) {
  const index = { complete: true, projects: projects.map(({ id, title, status }) => ({ id, title, status })) };
  const serialized = JSON.stringify(index);
  return Buffer.byteLength(serialized, "utf8") <= INTAKE_PROJECT_INDEX_MAX_BYTES
    ? serialized
    : JSON.stringify({ complete: false, projects: [] });
}

export function assertIntakeDestinations(
  db: Db,
  draft: IntakeDraft,
  scope: string,
  viewerMemberId: number | null,
  committedKeys: ReadonlySet<string> = new Set(),
): void {
  const eligible = new Map(intakeExistingProjects(db, scope, viewerMemberId).map((project) => [project.id, project]));
  const issues = draft.workItems.flatMap((item, index) => {
    if (!item.enabled || item.existingProjectId == null || committedKeys.has(item.key)) return [];
    const project = eligible.get(item.existingProjectId);
    if (item.kind === "action" && item.parentKey === null && project &&
      item.existingProjectRevision === project.revision) return [];
    return [{
      path: ["workItems", index, "existingProjectId"],
      code: "invalid_parent",
      message: "The destination is unavailable or has changed. Choose a destination again or remove the association.",
    }];
  });
  if (issues.length) throw AppError.badRequest("intake_draft_invalid", "Review the project destinations.", { issues });
}
