import type {
  ProjectReadiness,
  RefinementActionCode,
  RefinementBlockingReason,
  RefinementIssue,
  RefinementIssueCode,
  RefinementIssueSeverity,
} from "@machbar/shared";
import type { Graph, ProjectRecord, TaskRecord } from "./graph.js";

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

function unresolvedDependencies(graph: Graph, task: TaskRecord): TaskRecord[] {
  return task.dependencies
    .filter((dependency) => !dependency.resolved)
    .map((dependency) => graph.tasksById.get(dependency.dependsOnTaskId))
    .filter((dependency): dependency is TaskRecord => dependency !== undefined)
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.title.localeCompare(b.title, "de") ||
        a.id - b.id,
    );
}

type BlockingPrerequisiteReason = RefinementBlockingReason;

interface BlockingPrerequisite {
  task: TaskRecord;
  reason: BlockingPrerequisiteReason;
  path: TaskRecord[];
}

function blockingPrerequisiteInBranch(
  graph: Graph,
  task: TaskRecord,
  today: string,
  visiting: Set<number>,
  path: TaskRecord[],
): BlockingPrerequisite | null {
  if (!isOpen(task)) return null;
  const nextPath = [...path, task];
  if (visiting.has(task.id)) {
    return { task, reason: "cycle", path: nextPath };
  }
  if (task.status === "captured") {
    return { task, reason: "captured", path: nextPath };
  }
  const project =
    task.projectId === null ? null : graph.projectsById.get(task.projectId);
  if (project?.status === "completed" || project?.status === "archived") {
    return { task, reason: "terminal_project", path: nextPath };
  }

  const dependencies = unresolvedDependencies(graph, task);
  const nextVisiting = new Set(visiting).add(task.id);
  if (task.status === "actionable") {
    for (const dependency of dependencies) {
      const diagnosis = blockingPrerequisiteInBranch(
        graph,
        dependency,
        today,
        nextVisiting,
        nextPath,
      );
      if (diagnosis) return diagnosis;
    }
    return null;
  }
  if (
    task.status === "waiting" &&
    task.scheduledDate !== null &&
    task.scheduledDate > today
  ) {
    for (const dependency of dependencies) {
      const diagnosis = blockingPrerequisiteInBranch(
        graph,
        dependency,
        today,
        nextVisiting,
        nextPath,
      );
      if (diagnosis) return diagnosis;
    }
    return null;
  }
  if (task.status === "waiting") {
    return { task, reason: "waiting", path: nextPath };
  }
  return { task, reason: "someday", path: nextPath };
}

export function findBlockingPrerequisite(
  graph: Graph,
  task: TaskRecord,
  today: string,
): BlockingPrerequisite | null {
  for (const dependency of unresolvedDependencies(graph, task)) {
    const diagnosis = blockingPrerequisiteInBranch(
      graph,
      dependency,
      today,
      new Set([task.id]),
      [task],
    );
    if (diagnosis) return diagnosis;
  }
  return null;
}

export function blockedTaskHasClearPath(
  graph: Graph,
  task: TaskRecord,
  today: string,
): boolean {
  const dependencies = unresolvedDependencies(graph, task);
  return dependencies.length > 0 && findBlockingPrerequisite(graph, task, today) === null;
}

function blockingPrerequisiteIssue(
  task: TaskRecord,
  diagnosis: BlockingPrerequisite,
): RefinementIssue {
  const target = diagnosis.task;
  const dependencyPath = diagnosis.path.map((pathTask) => ({
    taskId: pathTask.id,
    title: pathTask.title,
  }));

  if (diagnosis.reason === "captured") {
    return taskIssue(task, "blocked_without_clear_path", "warning", {
      blockingReason: diagnosis.reason,
      suggestedAction: {
        code: "clarify_task",
        targetTaskId: target.id,
      },
      dependencyPath,
    });
  }
  if (diagnosis.reason === "waiting") {
    return taskIssue(task, "blocked_without_clear_path", "warning", {
      blockingReason: diagnosis.reason,
      suggestedAction: {
        code: "set_followup",
        targetTaskId: target.id,
      },
      dependencyPath,
    });
  }
  if (diagnosis.reason === "cycle") {
    return taskIssue(task, "blocked_without_clear_path", "warning", {
      blockingReason: diagnosis.reason,
      suggestedAction: {
        code: "resolve_blocker",
        targetTaskId: target.id,
      },
      dependencyPath,
    });
  }
  return taskIssue(task, "blocked_without_clear_path", "warning", {
    blockingReason: diagnosis.reason,
    suggestedAction: {
      code: "resolve_blocker",
      targetTaskId: target.id,
    },
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

  for (const project of graph.listProjectsWithComputed()) {
    if (project.status === "completed" || project.status === "archived") continue;
    const tasks = graph.tasksForProject(project.id);
    const openTasks = tasks.filter(isOpen);

    if (project.ownerMemberId === null) {
      issues.push(
        projectIssue(
          project,
          "missing_driver",
          project.status === "active" ? "urgent" : "info",
        ),
      );
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
          (!task.blocked || blockedTaskHasClearPath(graph, task, today)),
      ) &&
      !(
        openTasks.length > 0 &&
        openTasks.every(
          (task) =>
            task.status === "waiting" &&
            !!task.scheduledDate &&
            task.scheduledDate > today,
        )
      )
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

  for (const task of graph.allTasks()) {
    if (!isOpen(task)) continue;
    if (task.status === "captured") {
      issues.push(taskIssue(task, "needs_clarification", "warning"));
      continue;
    }
    if (task.status === "waiting") {
      if (!task.scheduledDate) {
        issues.push(taskIssue(task, "waiting_without_followup", "warning"));
      } else if (task.scheduledDate <= today) {
        issues.push(taskIssue(task, "followup_due", "urgent"));
      }
      continue;
    }
    if (task.status !== "actionable") continue;
    if (task.effectiveOwnerId === null) {
      issues.push(taskIssue(task, "unassigned_actionable", "warning"));
    }
    if (task.blocked) {
      const diagnosis = findBlockingPrerequisite(graph, task, today);
      if (diagnosis) {
        issues.push(blockingPrerequisiteIssue(task, diagnosis));
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
  issues.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.code.localeCompare(b.code) ||
      a.entityId - b.entityId,
  );

  const projects = graph
    .listProjectsWithComputed()
    .filter((project) => project.status === "backlog" || project.status === "active")
    .map((project) => {
      const projectIssues = issues.filter(
        (issue) => issue.projectId === project.id,
      );
      return {
        projectId: project.id,
        ready:
          project.ownerMemberId !== null &&
          project.acceptanceCriteria.length > 0 &&
          !projectIssues.some(
            (issue) =>
              issue.severity === "urgent" ||
              issue.code === "missing_next_action" ||
              issue.code === "waiting_without_followup",
          ),
        issues: projectIssues,
      };
    });

  return { issues, projects };
}
