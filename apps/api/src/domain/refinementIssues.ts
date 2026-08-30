import type {
  ProjectReadiness,
  RefinementActionCode,
  RefinementBlockingReason,
  RefinementIssue,
  RefinementIssueCode,
  RefinementIssueSeverity,
} from "@machbar/shared";
import type { Graph, ProjectRecord, TaskRecord } from "./graph.js";
import { isTaskInWorkingSystem } from "./workEligibility.js";
import { analyzeTaskBlockers } from "./blockers.js";

const actionCodeByIssue: Record<RefinementIssueCode, RefinementActionCode> = {
  missing_driver: "assign_driver",
  missing_outcome: "add_outcome",
  missing_next_action: "add_next_action",
  needs_clarification: "clarify_task",
  unassigned_actionable: "assign_task",
  waiting_without_followup: "set_followup",
  followup_due: "follow_up",
  blocked_without_clear_path: "resolve_blocker",
  due_without_plan: "plan_task",
  scheduled_in_past: "plan_task",
  too_large_without_children: "add_child",
  completion_review: "review_completion",
};

function projectIssue(
  project: ProjectRecord,
  code: RefinementIssueCode,
  severity: RefinementIssueSeverity,
): RefinementIssue {
  return {
    code,
    severity,
    suggestedAction: { code: actionCodeByIssue[code] },
    entityType: "project",
    entityId: project.id,
    entityTitle: project.title,
    projectId: project.id,
    projectTitle: project.title,
  };
}

function taskIssue(
  task: TaskRecord,
  code: RefinementIssueCode,
  severity: RefinementIssueSeverity,
  overrides: Partial<
    Pick<
      RefinementIssue,
      "blockingReason" | "suggestedAction" | "dependencyPath"
    >
  > = {},
): RefinementIssue {
  return {
    code,
    severity,
    suggestedAction: overrides.suggestedAction ?? {
      code: actionCodeByIssue[code],
    },
    entityType: "task",
    entityId: task.id,
    entityTitle: task.title,
    projectId: task.projectId,
    projectTitle: task.projectTitle ?? null,
    blockingReason: overrides.blockingReason,
    dependencyPath: overrides.dependencyPath,
  };
}

function isOpen(task: TaskRecord): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

function blockingPrerequisiteIssue(
  graph: Graph,
  task: TaskRecord,
  diagnosis: NonNullable<
    ReturnType<Graph["blockerAnalysisFor"]>
  >["diagnoses"][number],
): RefinementIssue {
  const target = graph.tasksById.get(diagnosis.targetTaskId);
  const dependencyPath = diagnosis.path.map((taskId) => ({
    taskId,
    title: graph.tasksById.get(taskId)?.title ?? `#${taskId}`,
  }));
  const blockingReason: RefinementBlockingReason =
    (diagnosis.reason === "missing_task"
      ? "cycle"
      : diagnosis.reason) as RefinementBlockingReason;
  const suggestedAction =
    blockingReason === "captured"
      ? { code: "clarify_task" as const, targetTaskId: diagnosis.targetTaskId }
      : blockingReason === "waiting_without_followup"
        ? { code: "set_followup" as const, targetTaskId: diagnosis.targetTaskId }
        : blockingReason === "followup_due"
          ? { code: "follow_up" as const, targetTaskId: diagnosis.targetTaskId }
          : {
              code: "resolve_blocker" as const,
              targetTaskId: target?.id ?? diagnosis.targetTaskId,
            };
  return taskIssue(task, "blocked_without_clear_path", "warning", {
    blockingReason,
    suggestedAction,
    dependencyPath,
  });
}

export interface RefinementIssueResult {
  issues: RefinementIssue[];
  projects: ProjectReadiness[];
}

/** Central clarification diagnostics consumed by every guided refinement surface. */
export function buildRefinementIssues(
  graph: Graph,
  today = new Date().toISOString().slice(0, 10),
): RefinementIssueResult {
  const issues: RefinementIssue[] = [];
  const projectStatuses = new Map(
    [...graph.projectsById.values()].map((project) => [
      project.id,
      project.status,
    ]),
  );
  const blockerAnalysis = analyzeTaskBlockers(
    new Map(
      graph.allTasks().map((task) => [
        task.id,
        {
          id: task.id,
          title: task.title,
          status: task.status,
          projectId: task.projectId,
          scheduledDate: task.scheduledDate,
          externalWait: task.externalWait,
          dependencies: task.dependencies.map((dependency) => ({
            dependsOnTaskId: dependency.dependsOnTaskId,
            resolved: dependency.resolved ?? false,
          })),
        },
      ]),
    ),
    projectStatuses,
    today,
  );

  for (const project of graph.listProjectsWithComputed()) {
    if (project.status !== "active") continue;
    const tasks = graph.tasksForProject(project.id);
    const openTasks = tasks.filter(isOpen);

    if (project.ownerMemberId === null) {
      issues.push(projectIssue(project, "missing_driver", "urgent"));
    }
    if (project.acceptanceCriteria.length === 0) {
      issues.push(projectIssue(project, "missing_outcome", "warning"));
    }
    if (
      openTasks.length === 0 &&
      tasks.length > 0 &&
      project.status === "active"
    ) {
      issues.push(projectIssue(project, "completion_review", "info"));
    } else if (
      !openTasks.some(
        (task) =>
          task.status === "actionable" &&
          (blockerAnalysis.get(task.id)?.executable ||
            blockerAnalysis.get(task.id)?.healthyProgressPath),
      ) &&
      !openTasks.some((task) => task.status === "captured")
    ) {
      issues.push(projectIssue(project, "missing_next_action", "warning"));
    }
    if (
      project.dueDate &&
      openTasks.length > 0 &&
      !openTasks.some((task) => task.dueDate || task.scheduledDate)
    ) {
      issues.push(projectIssue(project, "due_without_plan", "warning"));
    }
  }

  const projectStatusById = new Map(
    [...graph.projectsById.values()].map((project) => [
      project.id,
      project.status,
    ]),
  );
  for (const task of graph.allTasks()) {
    if (!isOpen(task)) continue;
    if (!isTaskInWorkingSystem(task, projectStatusById)) continue;
    if (task.status === "captured") {
      issues.push(taskIssue(task, "needs_clarification", "warning"));
      continue;
    }
    if (task.externalWait) {
      if (!task.scheduledDate) {
        issues.push(taskIssue(task, "waiting_without_followup", "warning"));
      } else if (task.scheduledDate <= today) {
        issues.push(taskIssue(task, "followup_due", "urgent"));
      }
    }
    if (task.status !== "actionable") continue;
    if (task.effectiveOwnerId === null) {
      issues.push(taskIssue(task, "unassigned_actionable", "warning"));
    }
    if (task.blocked) {
      const diagnoses = blockerAnalysis.get(task.id)?.diagnoses ?? [];
      for (const diagnosis of diagnoses) {
        issues.push(blockingPrerequisiteIssue(graph, task, diagnosis));
      }
    }
    if (task.size === "XL" && !task.children.some(isOpen)) {
      issues.push(taskIssue(task, "too_large_without_children", "warning"));
    }
  }

  const severityOrder: Record<RefinementIssueSeverity, number> = {
    urgent: 0,
    warning: 1,
    info: 2,
  };
  const issueOrder: Partial<Record<RefinementIssueCode, number>> = {
    followup_due: 0,
    waiting_without_followup: 1,
    blocked_without_clear_path: 2,
    needs_clarification: 3,
    unassigned_actionable: 4,
  };
  issues.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      (issueOrder[a.code] ?? 10) - (issueOrder[b.code] ?? 10) ||
      a.code.localeCompare(b.code) ||
      a.entityId - b.entityId,
  );

  const projects = graph
    .listProjectsWithComputed()
    .filter((project) => project.status === "backlog")
    .map((project) => {
      const openTasks = graph.tasksForProject(project.id).filter(isOpen);
      const projectIssues: RefinementIssue[] = [];
      if (project.ownerMemberId === null) {
        projectIssues.push(projectIssue(project, "missing_driver", "info"));
      }
      if (project.acceptanceCriteria.length === 0) {
        projectIssues.push(projectIssue(project, "missing_outcome", "info"));
      }
      if (
        !openTasks.some(
          (task) =>
            task.status === "actionable" &&
            (task.executable ||
              blockerAnalysis.get(task.id)?.healthyProgressPath),
        )
      ) {
        projectIssues.push(
          projectIssue(project, "missing_next_action", "info"),
        );
      }
      return {
        projectId: project.id,
        ready: project.ownerMemberId !== null,
        issues: projectIssues,
      };
    });

  return { issues, projects };
}
