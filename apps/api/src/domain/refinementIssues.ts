import type {
  ProjectReadiness,
  RefinementActionCode,
  RefinementIssue,
  RefinementIssueCode,
  RefinementIssueSeverity,
} from "@machbar/shared";
import type { Graph, ProjectRecord, TaskRecord } from "./graph.js";

const issueCopy: Record<
  RefinementIssueCode,
  {
    label: string;
    explanation: string;
    actionCode: RefinementActionCode;
    actionLabel: string;
  }
> = {
  missing_driver: {
    label: "Verantwortliche Person fehlt",
    explanation: "Das Projekt braucht eine Person, die den Überblick behält.",
    actionCode: "assign_driver",
    actionLabel: "Verantwortliche Person setzen",
  },
  missing_outcome: {
    label: "Ergebnis noch unklar",
    explanation: "Es fehlt mindestens ein konkreter Punkt unter „Erledigt, wenn …“.",
    actionCode: "add_outcome",
    actionLabel: "Ergebnis ergänzen",
  },
  missing_next_action: {
    label: "Kein nächster Schritt",
    explanation: "Es gibt keine geklärte, machbare Aufgabe, mit der es weitergehen kann.",
    actionCode: "add_next_action",
    actionLabel: "Nächsten Schritt hinzufügen",
  },
  needs_clarification: {
    label: "Aufgabe braucht Klärung",
    explanation: "Die Aufgabe wurde erfasst, ist aber noch nicht als nächster Schritt geklärt.",
    actionCode: "clarify_task",
    actionLabel: "Aufgabe klären",
  },
  unassigned_actionable: {
    label: "Ohne Zuständigkeit",
    explanation: "Die machbare Aufgabe ist noch keiner Person zugeordnet.",
    actionCode: "assign_task",
    actionLabel: "Person zuweisen",
  },
  waiting_without_followup: {
    label: "Wartet ohne Wiedervorlage",
    explanation: "Ohne Wiedervorlage kann diese wartende Aufgabe leicht vergessen werden.",
    actionCode: "set_followup",
    actionLabel: "Wiedervorlage setzen",
  },
  followup_due: {
    label: "Nachhaken fällig",
    explanation: "Die Wiedervorlage ist erreicht. Jetzt nachhaken oder die Aufgabe wieder machbar machen.",
    actionCode: "follow_up",
    actionLabel: "Nachhaken",
  },
  blocked_without_clear_path: {
    label: "Blockiert ohne klaren Weg",
    explanation: "Offene Abhängigkeiten verhindern den nächsten Schritt.",
    actionCode: "resolve_blocker",
    actionLabel: "Blockierung klären",
  },
  due_without_plan: {
    label: "Fällig, aber nicht machbar",
    explanation: "Der Termin rückt näher, aber es ist keine offene Aufgabe geplant.",
    actionCode: "plan_task",
    actionLabel: "Aufgabe planen",
  },
  scheduled_in_past: {
    label: "Planung überfällig",
    explanation: "Der geplante Termin ist vorbei und die Aufgabe noch offen.",
    actionCode: "plan_task",
    actionLabel: "Neu planen",
  },
  too_large_without_children: {
    label: "Zu groß — bitte aufteilen",
    explanation: "Diese XL-Aufgabe hat noch keine offenen Teilaufgaben.",
    actionCode: "add_child",
    actionLabel: "Teilaufgabe hinzufügen",
  },
  completion_review: {
    label: "Bereit zum Abschließen",
    explanation: "Alle vorhandenen Aufgaben sind erledigt oder verworfen.",
    actionCode: "review_completion",
    actionLabel: "Projekt prüfen",
  },
};

function projectIssue(
  project: ProjectRecord,
  code: RefinementIssueCode,
  severity: RefinementIssueSeverity,
): RefinementIssue {
  const copy = issueCopy[code];
  return {
    code,
    severity,
    label: copy.label,
    explanation: copy.explanation,
    suggestedAction: { code: copy.actionCode, label: copy.actionLabel },
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
): RefinementIssue {
  const copy = issueCopy[code];
  return {
    code,
    severity,
    label: copy.label,
    explanation: copy.explanation,
    suggestedAction: { code: copy.actionCode, label: copy.actionLabel },
    entityType: "task",
    entityId: task.id,
    entityTitle: task.title,
    projectId: task.projectId,
    projectTitle: task.projectTitle ?? null,
  };
}

function isOpen(task: TaskRecord): boolean {
  return task.status !== "done" && task.status !== "cancelled";
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
          !task.needsClarification &&
          !task.blocked,
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
    if (task.needsClarification) {
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
      issues.push(taskIssue(task, "blocked_without_clear_path", "warning"));
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
      a.label.localeCompare(b.label, "de") ||
      a.entityTitle.localeCompare(b.entityTitle, "de"),
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
