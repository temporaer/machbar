import type {
  ProjectActivationDecisionSnapshot,
  ProjectActivationResolution,
  ProjectStatus,
  TaskStatus,
} from "@machbar/shared";

export interface CommitmentTransitionProjectSnapshot {
  projectId: number;
  title: string;
  parentId: number | null;
  revision: number;
  status: ProjectStatus;
  ownerMemberId: number | null;
  hasViableProgressPath: boolean;
  hasHealthyFutureWaiting: boolean;
  hasHealthyFutureRevisit: boolean;
}

export interface CommitmentTransitionSnapshot {
  today: string;
  subject: {
    type: "task" | "project";
    id: number;
    status: TaskStatus | ProjectStatus;
    targetStatus: TaskStatus | ProjectStatus;
    executionCommitment: boolean;
    newExecutionCommitment: boolean;
    revisitAt: string | null;
    recurring: boolean;
    explicitlyReopened: boolean;
  };
  /** Nearest project first, matching the source task/project's ancestor chain. */
  projects: CommitmentTransitionProjectSnapshot[];
}

export type CommitmentTransitionIntent =
  | "commitment"
  | "explicit_activation";

export interface CommitmentTransitionPlan {
  /** A committed task plan normalizes open captured/Someday work to actionable. */
  taskStatus: TaskStatus | null;
  /** The affected backlog projects, ordered from the target outward. */
  projectActivations: Array<{
    projectId: number;
    revision: number;
    ownerMemberId: number;
  }>;
  /** A user-authored action is created only when it supplies a missing path. */
  nextAction: { projectId: number; title: string } | null;
}

export type CommitmentTransitionEvaluation =
  | { kind: "ready"; plan: CommitmentTransitionPlan }
  | {
      kind: "needs_decisions";
      decisionSnapshot: ProjectActivationDecisionSnapshot;
    }
  | {
      kind: "conflict";
      reason:
        | "stale_project_snapshot"
        | "invalid_project_decision"
        | "terminal_task_requires_reopen";
      decisionSnapshot?: ProjectActivationDecisionSnapshot;
    };

export interface CommitmentTransitionDecisions {
  resolution?: ProjectActivationResolution;
  /** Explicit owner chosen by the existing direct-activation action. */
  ownerMemberId?: number | null;
}

export function hasExecutionCommitment(input: {
  kind: "action" | "reference";
  dueDate: string | null;
  scheduledDate: string | null;
  revisitAt?: string | null;
  reminders: readonly unknown[];
}): boolean {
  return input.kind === "action" && (
    input.dueDate !== null || input.scheduledDate !== null ||
    (input.reminders.length > 0 && (input.revisitAt ?? null) === null)
  );
}

export function hasProjectProgressPath(project: Pick<
  CommitmentTransitionProjectSnapshot,
  "hasViableProgressPath" | "hasHealthyFutureWaiting" | "hasHealthyFutureRevisit"
>): boolean {
  return project.hasViableProgressPath || project.hasHealthyFutureWaiting || project.hasHealthyFutureRevisit;
}

export function committedTaskStatus(
  status: TaskStatus,
  executionCommitment: boolean,
): TaskStatus {
  return executionCommitment && (status === "captured" || status === "someday")
    ? "actionable"
    : status;
}

/**
 * Pure commitment/activation decision. Its snapshot already contains the
 * graph-derived readiness and explicit date boundary; it has no DB, clock,
 * transport, or presentation dependencies.
 */
export function evaluateCommitmentTransition(
  snapshot: CommitmentTransitionSnapshot,
  intent: CommitmentTransitionIntent,
  decisions: CommitmentTransitionDecisions = {},
): CommitmentTransitionEvaluation {
  const resolution = decisions.resolution;
  const taskStatus = snapshot.subject.type === "task" && intent === "commitment"
    ? committedTaskStatus(snapshot.subject.targetStatus as TaskStatus, snapshot.subject.executionCommitment)
    : null;

  if (
    snapshot.subject.type === "task" && intent === "commitment" &&
    snapshot.subject.newExecutionCommitment &&
    (snapshot.subject.status === "done" || snapshot.subject.status === "cancelled") &&
    !snapshot.subject.explicitlyReopened
  ) {
    return { kind: "conflict", reason: "terminal_task_requires_reopen" };
  }

  const shouldActivate = intent === "explicit_activation" || (
    intent === "commitment" && snapshot.subject.executionCommitment
  );
  const backlog = shouldActivate
    ? snapshot.projects.filter((project) => project.status === "backlog" ||
      (intent === "explicit_activation" && project.status === "completed"))
    : [];
  if (backlog.length === 0) {
    return { kind: "ready", plan: { taskStatus, projectActivations: [], nextAction: null } };
  }

  const revisionByProject = new Map((resolution?.expectedProjects ?? []).map(({ projectId, revision }) => [projectId, revision]));
  if (resolution && (
    revisionByProject.size !== resolution.expectedProjects.length ||
    revisionByProject.size !== backlog.length ||
    backlog.some((project) => revisionByProject.get(project.projectId) !== project.revision) ||
    [...revisionByProject.keys()].some((projectId) => !backlog.some((project) => project.projectId === projectId))
  )) {
    return {
      kind: "conflict",
      reason: "stale_project_snapshot",
      decisionSnapshot: requirementsFor(snapshot, backlog),
    };
  }

  const assignments = resolution?.drivers ?? [];
  const ownerByProject = new Map(assignments.map(({ projectId, ownerMemberId }) => [projectId, ownerMemberId]));
  const overrideProjectId = snapshot.subject.type === "project" ? snapshot.subject.id : null;
  if (overrideProjectId !== null && decisions.ownerMemberId != null) {
    ownerByProject.set(overrideProjectId, decisions.ownerMemberId);
  }
  if (
    new Map(assignments.map(({ projectId, ownerMemberId }) => [projectId, ownerMemberId])).size !== assignments.length ||
    assignments.some(({ projectId }) => !backlog.some((project) => project.projectId === projectId)) ||
    assignments.some(({ projectId }) => snapshot.projects.find((project) => project.projectId === projectId)?.ownerMemberId !== null)
  ) {
    return { kind: "conflict", reason: "invalid_project_decision" };
  }

  const proposedTitle = resolution?.nextActionTitle?.trim() ?? "";
  const targetProjectId = snapshot.projects[0]?.projectId;
  let viableChildParentId: number | null =
    snapshot.projects[0]?.status === "active" ? snapshot.projects[0].parentId : null;
  const requirements: ProjectActivationDecisionSnapshot["projects"] = [];
  const activations: CommitmentTransitionPlan["projectActivations"] = [];
  let nextAction: CommitmentTransitionPlan["nextAction"] = null;

  for (const project of backlog) {
    const ownerMemberId = ownerByProject.get(project.projectId) ?? project.ownerMemberId;
    const proposedPath = project.projectId === targetProjectId && proposedTitle !== "";
    const hasExistingPath = hasProjectProgressPath(project) || viableChildParentId === project.projectId;
    const hasPath = hasExistingPath || proposedPath;
    viableChildParentId = hasPath ? project.parentId : null;
    const required: ProjectActivationDecisionSnapshot["projects"][number]["required"] = [];
    if (ownerMemberId === null) required.push("driver");
    if (!hasPath) required.push("progressPath");
    if (required.length > 0) {
      requirements.push({
        projectId: project.projectId,
        title: project.title,
        revision: project.revision,
        ownerMemberId: project.ownerMemberId,
        required,
      });
    }
    if (ownerMemberId !== null) {
      activations.push({ projectId: project.projectId, revision: project.revision, ownerMemberId });
    }
    if (proposedPath && !hasExistingPath) nextAction = { projectId: project.projectId, title: proposedTitle };
  }

  const decisionSnapshot: ProjectActivationDecisionSnapshot = {
    projects: requirements,
    expectedProjects: backlog.map(({ projectId, revision }) => ({ projectId, revision })),
    targetRevision: snapshot.projects[0]?.revision ?? 0,
  };
  if (requirements.length > 0) return { kind: "needs_decisions", decisionSnapshot };

  return { kind: "ready", plan: { taskStatus, projectActivations: activations, nextAction } };
}

function requirementsFor(
  snapshot: CommitmentTransitionSnapshot,
  backlog: CommitmentTransitionProjectSnapshot[],
): ProjectActivationDecisionSnapshot {
  const projects: ProjectActivationDecisionSnapshot["projects"] = [];
  let viableChildParentId: number | null = snapshot.projects[0]?.status === "active"
    ? snapshot.projects[0].parentId
    : null;
  for (const project of backlog) {
    const required: ProjectActivationDecisionSnapshot["projects"][number]["required"] = [];
    if (project.ownerMemberId === null) required.push("driver");
    const hasPath = hasProjectProgressPath(project) || viableChildParentId === project.projectId;
    if (!hasPath) required.push("progressPath");
    viableChildParentId = hasPath ? project.parentId : null;
    if (required.length > 0) projects.push({
      projectId: project.projectId,
      title: project.title,
      revision: project.revision,
      ownerMemberId: project.ownerMemberId,
      required,
    });
  }
  return {
    projects,
    expectedProjects: backlog.map(({ projectId, revision }) => ({ projectId, revision })),
    targetRevision: snapshot.projects[0]?.revision ?? 0,
  };
}
