import { and, eq, sql } from "drizzle-orm";
import type { ProjectActivationResolution, ProjectStatus } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { recordActivity, recordContribution } from "../repo/index.js";
import { getProjectActivationReadiness } from "./projectReadiness.js";
import { type MutationContext, actor, assertExpectedRevision, nowIso } from "./workItemShared.js";

type ProjectRow = {
  id: number;
  revision: number;
  parentId: number | null;
  title: string;
  status: string;
  archivedAt: string | null;
  ownerMemberId: number | null;
};

function statusOf(project: ProjectRow): ProjectStatus {
  if (project.archivedAt !== null) return "archived";
  if (project.status === "done") return "completed";
  return project.status === "active" ? "active" : "backlog";
}

function projectChain(db: Db, projectId: number): ProjectRow[] {
  const chain: ProjectRow[] = [];
  const visited = new Set<number>();
  let currentId: number | null = projectId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw AppError.conflict("project_transition_invalid", "The project hierarchy contains a cycle.", { projectId });
    }
    visited.add(currentId);
    const project = db
      .select({
        id: schema.workItems.id,
        revision: schema.workItems.revision,
        parentId: schema.workItems.parentId,
        title: schema.workItems.title,
        status: schema.workItems.status,
        archivedAt: schema.workItems.archivedAt,
        ownerMemberId: schema.workItems.ownerMemberId,
      })
      .from(schema.workItems)
      .where(and(eq(schema.workItems.id, currentId), eq(schema.workItems.role, "story")))
      .get();
    if (!project) break;
    chain.push(project);
    currentId = project.parentId;
  }
  return chain;
}

export function projectNeedsProgressPath(
  db: Db,
  projectId: number,
  ownerMemberId: number | null,
): boolean {
  const readiness = getProjectActivationReadiness(db, projectId, ownerMemberId);
  return !(
    readiness.hasViableProgressPath ||
    readiness.hasHealthyFutureWaiting ||
    readiness.hasHealthyFutureRevisit
  );
}

/** The single low-level activation write used by explicit and commitment-driven activation. */
export function applyProjectActivation(
  db: Db,
  project: ProjectRow,
  ownerMemberId: number,
  context?: MutationContext,
): number {
  db.update(schema.workItems)
    .set({
      status: "active",
      archivedAt: null,
      completedAt: null,
      revisitAt: null,
      ownerMemberId,
      revision: sql`${schema.workItems.revision} + 1`,
      updatedAt: nowIso(),
    })
    .where(eq(schema.workItems.id, project.id))
    .run();
  const activityEventId = recordActivity(db, {
    actorMemberId: actor(context),
    kind: "project_status_changed",
    entityType: "project",
    entityTitle: project.title,
    projectId: project.id,
    metadata: {
      previousStatus: statusOf(project),
      nextStatus: "active",
      ...(ownerMemberId !== project.ownerMemberId ? { changedFields: ["ownerMemberId"] } : {}),
    },
  });
  if (project.ownerMemberId === null) {
    recordContribution(db, {
      activityEventId,
      actorMemberId: actor(context),
      category: "planning",
      reason: "project_driver_assigned",
      entityType: "project",
      entityId: project.id,
      personalEligible: true,
    });
  }
  return activityEventId;
}

/**
 * Activates a backlog project and any backlog ancestors after an explicit
 * execution commitment has made a viable path available. Missing decisions
 * are returned before any project status is changed; callers are already
 * inside the source mutation's transaction, so throwing rolls back that
 * source edit as well.
 */
export function activateCommittedProjectChain(
  db: Db,
  projectId: number,
  context?: MutationContext,
  resolution?: ProjectActivationResolution,
): void {
  const chain = projectChain(db, projectId);
  const backlog = chain.filter((project) => statusOf(project) === "backlog");
  if (backlog.length === 0) return;

  const assignmentByProject = new Map(
    (resolution?.drivers ?? []).map((assignment) => [assignment.projectId, assignment.ownerMemberId]),
  );
  if (resolution) {
    if (
      assignmentByProject.size !== resolution.drivers.length ||
      new Set(resolution.expectedProjects.map(({ projectId }) => projectId)).size !== resolution.expectedProjects.length
    ) {
      throw AppError.conflict(
        "project_commitment_resolution_required",
        "Project decisions must be unique and refreshed before committing this work plan.",
        { reason: "duplicate_project_decision" },
      );
    }
    const revisionByProject = new Map(resolution.expectedProjects.map((entry) => [entry.projectId, entry.revision]));
    if (
      revisionByProject.size !== backlog.length ||
      backlog.some((project) => !revisionByProject.has(project.id)) ||
      [...revisionByProject.keys()].some((id) => !backlog.some((project) => project.id === id))
    ) {
      throw AppError.conflict(
        "project_commitment_resolution_required",
        "Refresh the project decisions before committing this work plan.",
        {
          reason: "project_snapshot_incomplete",
          expectedProjectIds: [...revisionByProject.keys()],
          affectedProjectIds: backlog.map(({ id }) => id),
        },
      );
    }
    for (const project of backlog) {
      const expectedRevision = revisionByProject.get(project.id);
      assertExpectedRevision("project", project.id, project.revision, expectedRevision!);
    }
  }

  const missing: Array<{
    projectId: number;
    title: string;
    revision: number;
    ownerMemberId: number | null;
    required: Array<"driver" | "progressPath">;
  }> = [];
  let viableChildParentId: number | null =
    chain[0] && statusOf(chain[0]) === "active" ? chain[0].parentId : null;
  // The chain is nearest-first. Once a child project is viable, it is a
  // meaningful progress path for its parent as well.
  for (const project of backlog) {
    const ownerMemberId = assignmentByProject.get(project.id) ?? project.ownerMemberId;
    const readiness = getProjectActivationReadiness(db, project.id, ownerMemberId);
    const hasPath = readiness.hasViableProgressPath || readiness.hasHealthyFutureWaiting ||
      readiness.hasHealthyFutureRevisit || viableChildParentId === project.id;
    viableChildParentId = hasPath ? project.parentId : null;
    const required: Array<"driver" | "progressPath"> = [];
    if (ownerMemberId === null) required.push("driver");
    if (!hasPath) required.push("progressPath");
    if (required.length > 0) {
      missing.push({ projectId: project.id, title: project.title, revision: project.revision, ownerMemberId: project.ownerMemberId, required });
    }
  }
  if (missing.length > 0) {
    throw AppError.conflict(
      "project_commitment_resolution_required",
      "This commitment needs a project driver or a viable next action before the project can be activated.",
      {
        projects: missing,
        expectedProjects: backlog.map(({ id, revision }) => ({ projectId: id, revision })),
      },
    );
  }

  // Validate every explicit assignment before the first write.
  for (const [id, ownerMemberId] of assignmentByProject) {
    const project = backlog.find((candidate) => candidate.id === id);
    if (!project || project.ownerMemberId !== null) {
      throw AppError.conflict("project_commitment_resolution_required", "A project driver decision is no longer applicable.", { projectId: id, reason: "driver_changed" });
    }
    const member = db.select({ id: schema.members.id }).from(schema.members).where(eq(schema.members.id, ownerMemberId)).get();
    if (!member) throw AppError.notFound("member_not_found", "The selected project driver was not found.", { memberId: ownerMemberId });
  }

  // Activate from the affected project outward so parent readiness can rely
  // on a now-active child project when the parent has no direct task rows.
  for (const project of backlog) {
    const ownerMemberId = assignmentByProject.get(project.id) ?? project.ownerMemberId;
    applyProjectActivation(db, project, ownerMemberId!, context);
  }
}
