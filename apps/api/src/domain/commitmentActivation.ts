import { and, eq, sql } from "drizzle-orm";
import type {
  ProjectActivationDecisionSnapshot,
  ProjectActivationResolution,
  ProjectStatus,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { recordActivity, recordContribution } from "../repo/index.js";
import { getProjectActivationReadiness } from "./projectReadiness.js";
import { insertTaskRow } from "./taskRowInsert.js";
import { type MutationContext, actor, nowIso } from "./workItemShared.js";
import {
  evaluateCommitmentTransition,
  type CommitmentTransitionSnapshot,
} from "./commitmentTransition.js";

type ProjectRow = {
  id: number;
  revision: number;
  parentId: number | null;
  title: string;
  status: string;
  archivedAt: string | null;
  ownerMemberId: number | null;
  scope: "household" | "work";
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
        scope: schema.workItems.scope,
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

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadCommitmentTransitionSnapshot(
  db: Db,
  projectId: number,
  subject: CommitmentTransitionSnapshot["subject"],
  today = isoToday(),
): CommitmentTransitionSnapshot {
  const projects = projectChain(db, projectId).map((project) => {
    const readiness = getProjectActivationReadiness(db, project.id, project.ownerMemberId, today);
    return {
      projectId: project.id,
      title: project.title,
      parentId: project.parentId,
      revision: project.revision,
      status: statusOf(project),
      ownerMemberId: project.ownerMemberId,
      hasViableProgressPath: readiness.hasViableProgressPath,
      hasHealthyFutureWaiting: readiness.hasHealthyFutureWaiting,
      hasHealthyFutureRevisit: readiness.hasHealthyFutureRevisit === true,
    };
  });
  if (projects.length === 0) throw AppError.notFound("project_not_found", "The project was not found.", { projectId });
  return { today, subject, projects };
}

/** Current server-computed requirements and revisions for decision sheets. */
export function projectActivationDecisionSnapshot(
  db: Db,
  projectId: number,
  intent: "commitment" | "explicit_activation" = "commitment",
  today = isoToday(),
): ProjectActivationDecisionSnapshot {
  const project = projectChain(db, projectId)[0];
  if (!project) throw AppError.notFound("project_not_found", "The project was not found.", { projectId });
  const snapshot = loadCommitmentTransitionSnapshot(db, projectId, {
    type: "project",
    id: project.id,
    status: statusOf(project),
    targetStatus: statusOf(project),
    executionCommitment: true,
    newExecutionCommitment: true,
    revisitAt: null,
    recurring: false,
    explicitlyReopened: false,
  }, today);
  const decisionSnapshot = intent === "explicit_activation"
    ? { ...snapshot, projects: [snapshot.projects[0]!] }
    : snapshot;
  const result = evaluateCommitmentTransition(decisionSnapshot, intent);
  if (result.kind === "needs_decisions" || result.kind === "conflict") {
    if (result.decisionSnapshot) return result.decisionSnapshot;
  }
  return {
    projects: [],
    expectedProjects: decisionSnapshot.projects
      .filter((entry) => entry.status === "backlog" || (intent === "explicit_activation" && entry.status === "completed"))
      .map(({ projectId: id, revision }) => ({ projectId: id, revision })),
    targetRevision: project.revision,
  };
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
  subject?: CommitmentTransitionSnapshot["subject"],
): void {
  const target = projectChain(db, projectId)[0];
  if (!target) throw AppError.notFound("project_not_found", "The project was not found.", { projectId });
  const effectiveSubject = subject ?? {
    type: "project" as const,
    id: target.id,
    status: statusOf(target),
    targetStatus: statusOf(target),
    executionCommitment: true,
    newExecutionCommitment: true,
    revisitAt: null,
    recurring: false,
    explicitlyReopened: false,
  };
  const snapshot = loadCommitmentTransitionSnapshot(db, projectId, effectiveSubject);
  const result = evaluateCommitmentTransition(snapshot, "commitment", { resolution });
  if (result.kind === "needs_decisions") {
    throw AppError.conflict(
      "project_commitment_resolution_required",
      "This commitment needs a project driver or a viable next action before the project can be activated.",
      { ...result.decisionSnapshot },
    );
  }
  if (result.kind === "conflict") {
    if (result.reason === "stale_project_snapshot" && result.decisionSnapshot) {
      throw AppError.conflict(
        "project_commitment_resolution_required",
        "Refresh the project decisions before committing this work plan.",
        { reason: "project_snapshot_stale", ...result.decisionSnapshot },
      );
    }
    if (result.reason === "terminal_task_requires_reopen") {
      throw AppError.conflict(
        "task_reopen_required",
        "Reopen this completed or cancelled task before adding an execution commitment.",
        { taskId: effectiveSubject.id, currentStatus: effectiveSubject.status, requiredStatus: "actionable" },
      );
    }
    throw AppError.conflict(
      "project_commitment_resolution_required",
      "A project driver decision is no longer applicable.",
      { reason: result.reason },
    );
  }

  applyTransitionPlan(db, projectId, result.plan, context);
}

/** Explicit lifecycle activation uses the same pure decision and write plan,
 * scoped to the selected project (unlike a commitment, which may activate its
 * backlog ancestors too). */
export function activateProjectFromWorkflow(
  db: Db,
  projectId: number,
  ownerMemberId: number | null,
  context?: MutationContext,
  resolution?: ProjectActivationResolution,
): number {
  const project = projectChain(db, projectId)[0];
  if (!project) throw AppError.notFound("project_not_found", "The project was not found.", { projectId });
  const status = statusOf(project);
  const snapshot = loadCommitmentTransitionSnapshot(db, projectId, {
    type: "project",
    id: projectId,
    status,
    targetStatus: status,
    executionCommitment: true,
    newExecutionCommitment: true,
    revisitAt: null,
    recurring: false,
    explicitlyReopened: false,
  });
  const target = snapshot.projects[0];
  if (!target) throw AppError.notFound("project_not_found", "The project was not found.", { projectId });
  const result = evaluateCommitmentTransition({ ...snapshot, projects: [target] }, "explicit_activation", {
    resolution,
    ownerMemberId,
  });
  if (result.kind === "needs_decisions") {
    if (result.decisionSnapshot.projects.some((project) => project.required.includes("driver"))) {
      throw AppError.badRequest("project_driver_required", "A project driver is required before the project can be activated.", { projectId });
    }
    throw AppError.conflict(
      "project_activation_not_ready",
      "An active project needs an executable progress path or a healthy future waiting point.",
      {
        projectId,
        hasViableProgressPath: target.hasViableProgressPath,
        hasHealthyFutureWaiting: target.hasHealthyFutureWaiting,
        hasHealthyFutureRevisit: target.hasHealthyFutureRevisit,
        requiredDecisions: result.decisionSnapshot.projects[0]?.required ?? ["progressPath"],
      },
    );
  }
  if (result.kind === "conflict") {
    if (result.reason === "stale_project_snapshot" && result.decisionSnapshot) {
      throw AppError.conflict(
        "project_commitment_resolution_required",
        "Refresh the project decisions before activating this project.",
        { reason: "project_snapshot_stale", ...result.decisionSnapshot },
      );
    }
    throw AppError.conflict("project_activation_not_ready", "The project activation decisions are no longer valid.", {
      projectId,
      reason: result.reason,
      ...(result.decisionSnapshot ?? {}),
    });
  }
  const eventId = applyTransitionPlan(db, projectId, result.plan, context);
  if (eventId === null) throw AppError.conflict("project_activation_not_ready", "No project activation was planned.", { projectId });
  return eventId;
}

function applyTransitionPlan(
  db: Db,
  projectId: number,
  plan: import("./commitmentTransition.js").CommitmentTransitionPlan,
  context?: MutationContext,
): number | null {
  let targetActivityEventId: number | null = null;
  for (const activation of plan.projectActivations) {
    const member = db.select({ id: schema.members.id })
      .from(schema.members).where(eq(schema.members.id, activation.ownerMemberId)).get();
    if (!member) throw AppError.notFound("member_not_found", "The selected project driver was not found.", { memberId: activation.ownerMemberId });
  }
  if (plan.nextAction) createCommitmentNextAction(db, plan.nextAction.projectId, plan.nextAction.title, context);

  const projectById = new Map(projectChain(db, projectId).map((project) => [project.id, project]));
  for (const activation of plan.projectActivations) {
    const project = projectById.get(activation.projectId);
    if (!project) throw AppError.notFound("project_not_found", "The project was not found.", { projectId: activation.projectId });
    const activityEventId = applyProjectActivation(db, project, activation.ownerMemberId, context);
    if (activation.projectId === projectId) targetActivityEventId = activityEventId;
  }
  return targetActivityEventId;
}

/** Inserts the explicit user-authored action selected as a missing progress path. */
export function createCommitmentNextAction(db: Db, projectId: number, title: string, context?: MutationContext) {
  const project = db.select({ id: schema.workItems.id, scope: schema.workItems.scope })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.id, projectId), eq(schema.workItems.role, "story")))
    .get();
  if (!project) throw AppError.notFound("project_not_found", "The project was not found.", { projectId });
  const task = insertTaskRow(db, {
    parentId: projectId,
    title: title.trim(),
    status: "actionable",
    scope: project.scope,
  });
  recordActivity(db, {
    actorMemberId: actor(context),
    kind: "task_created",
    entityType: "task",
    entityTitle: task.title,
    taskId: task.id,
    projectId,
    metadata: {},
  });
  return task;
}
