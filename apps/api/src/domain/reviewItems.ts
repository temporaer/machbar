import type {
  ReviewAction,
  ReviewCategory,
  ReviewItem,
  ReviewReason,
} from "@machbar/shared";
import type { Graph, ProjectRecord, TaskRecord } from "./graph.js";
import { isTaskInWorkingSystem } from "./workEligibility.js";

export const ACTIVE_REVIEW_DAYS = 14;
export const BACKLOG_REVIEW_DAYS = 30;
export const SOMEDAY_REVIEW_DAYS = 90;

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isOpen(task: TaskRecord): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

function attentionAt(entity: {
  updatedAt: string;
  reviewedAt: string | null;
}): string {
  return entity.reviewedAt && entity.reviewedAt > entity.updatedAt
    ? entity.reviewedAt
    : entity.updatedAt;
}

function projectAttentionAt(
  project: ProjectRecord,
  tasks: readonly TaskRecord[],
): string {
  return [attentionAt(project), ...tasks.map(attentionAt)].sort().at(-1)!;
}

function projectItem(
  project: ProjectRecord,
  category: ReviewCategory,
  reason: ReviewReason,
  suggestedAction: ReviewAction,
): ReviewItem {
  return {
    entityType: "project",
    entityId: project.id,
    entityTitle: project.title,
    projectId: project.id,
    projectTitle: project.title,
    category,
    reason,
    suggestedAction,
  };
}

function taskItem(
  task: TaskRecord,
  category: ReviewCategory,
  reason: ReviewReason,
  suggestedAction: ReviewAction,
): ReviewItem {
  return {
    entityType: "task",
    entityId: task.id,
    entityTitle: task.title,
    projectId: task.projectId,
    projectTitle: task.projectTitle ?? null,
    category,
    reason,
    suggestedAction,
  };
}

const reasonOrder: Record<ReviewReason, number> = {
  missing_driver: 0,
  no_viable_progress_path: 1,
  due_without_credible_plan: 2,
  waiting_without_followup: 3,
  broken_blocker_path: 4,
  xl_without_children: 5,
  completion_review: 6,
  active_stale: 7,
  backlog_due: 8,
  backlog_stale: 9,
  standalone_someday_stale: 10,
};

export interface BuildReviewItemsOptions {
  today?: string;
}

export function buildReviewItems(
  graph: Graph,
  options: BuildReviewItemsOptions = {},
): ReviewItem[] {
  const today =
    options.today ?? new Date().toISOString().slice(0, 10);
  const projectStatuses = new Map(
    [...graph.projectsById.values()].map((project) => [
      project.id,
      project.status,
    ]),
  );
  const items: ReviewItem[] = [];
  const projectsWithRootCause = new Set<number>();
  const brokenRootKeys = new Set<string>();

  for (const task of graph.allTasks()) {
    if (!isOpen(task)) continue;
    if (!isTaskInWorkingSystem(task, projectStatuses)) continue;

    if (task.externalWait && !task.scheduledDate) {
      items.push(
        taskItem(task, "clarification_repair", "waiting_without_followup", {
          code: "set_followup",
        }),
      );
      if (task.projectId !== null) projectsWithRootCause.add(task.projectId);
    }

    if (task.status === "actionable" && task.blocked) {
      const diagnosis = graph
        .blockerAnalysisFor(task.id)
        ?.diagnoses.find(
          (entry) =>
            entry.reason !== "waiting_without_followup" &&
            entry.reason !== "followup_due",
        );
      if (diagnosis) {
        const rootKey = `${task.projectId ?? "standalone"}:${diagnosis.reason}:${diagnosis.targetTaskId}`;
        if (!brokenRootKeys.has(rootKey)) {
          brokenRootKeys.add(rootKey);
          items.push(
            taskItem(task, "clarification_repair", "broken_blocker_path", {
              code: "resolve_blocker",
              targetEntityType: "task",
              targetEntityId: diagnosis.targetTaskId,
            }),
          );
        }
        if (task.projectId !== null) projectsWithRootCause.add(task.projectId);
      }
    }

    if (
      task.status === "actionable" &&
      task.size === "XL" &&
      !task.children.some(isOpen)
    ) {
      items.push(
        taskItem(task, "clarification_repair", "xl_without_children", {
          code: "add_child",
        }),
      );
    }
  }

  for (const project of graph.listProjectsWithComputed()) {
    const tasks = graph.tasksForProject(project.id);
    if (project.status === "active") {
      const openTasks = tasks.filter(isOpen);
      const canonicalCandidates = graph.nextActionCandidatesFor(project.id);
      const hasHealthyFutureWaiting = openTasks.some((task) => {
        const analysis = graph.blockerAnalysisFor(task.id);
        return (
          analysis?.blocked === true &&
          analysis.healthyProgressPath &&
          analysis.nextBlockerAttentionDate !== null &&
          analysis.nextBlockerAttentionDate > today
        );
      });
      if (project.ownerMemberId === null) {
        items.push(
          projectItem(
            project,
            "clarification_repair",
            "missing_driver",
            { code: "assign_driver" },
          ),
        );
      }
      if (tasks.length > 0 && openTasks.length === 0) {
        items.push(
          projectItem(project, "completion", "completion_review", {
            code: "review_completion",
          }),
        );
      } else if (
        canonicalCandidates.length === 0 &&
        !hasHealthyFutureWaiting &&
        !projectsWithRootCause.has(project.id)
      ) {
        items.push(
          projectItem(
            project,
            "clarification_repair",
            "no_viable_progress_path",
            { code: "add_next_action" },
          ),
        );
      }
      if (
        project.dueDate !== null &&
        openTasks.length > 0 &&
        !openTasks.some(
          (task) => task.dueDate !== null || task.scheduledDate !== null,
        )
      ) {
        const planningTarget = canonicalCandidates[0] ?? openTasks[0]!;
        items.push(
          projectItem(
            project,
            "clarification_repair",
            "due_without_credible_plan",
            {
              code: "plan_task",
              targetEntityType: "task",
              targetEntityId: planningTarget.id,
            },
          ),
        );
      }
      if (
        canonicalCandidates.length > 0 &&
        !hasHealthyFutureWaiting &&
        !items.some(
          (item) =>
            item.projectId === project.id &&
            item.category === "clarification_repair",
        ) &&
        projectAttentionAt(project, tasks).slice(0, 10) <=
          addDaysIso(today, -ACTIVE_REVIEW_DAYS)
      ) {
        items.push(
          projectItem(project, "reconsider", "active_stale", {
            code: "review_project",
          }),
        );
      }
    } else if (project.status === "backlog") {
      const acknowledgementExpired =
        project.reviewedAt === null ||
        project.reviewedAt.slice(0, 10) <=
          addDaysIso(today, -BACKLOG_REVIEW_DAYS);
      if (
        project.dueDate !== null &&
        project.dueDate <= today &&
        acknowledgementExpired
      ) {
        items.push(
          projectItem(project, "reconsider", "backlog_due", {
            code: "review_project",
          }),
        );
      } else if (
        projectAttentionAt(project, tasks).slice(0, 10) <=
        addDaysIso(today, -BACKLOG_REVIEW_DAYS)
      ) {
        items.push(
          projectItem(project, "reconsider", "backlog_stale", {
            code: "review_project",
          }),
        );
      }
    }
  }

  for (const task of graph.allTasks()) {
    if (
      task.projectId === null &&
      task.status === "someday" &&
      attentionAt(task).slice(0, 10) <=
        addDaysIso(today, -SOMEDAY_REVIEW_DAYS)
    ) {
      items.push(
        taskItem(task, "reconsider", "standalone_someday_stale", {
          code: "review_task",
        }),
      );
    }
  }

  return items.sort(
    (a, b) => {
      const reasonComparison =
        reasonOrder[a.reason] - reasonOrder[b.reason];
      if (reasonComparison !== 0) return reasonComparison;
      if (a.projectTitle === null && b.projectTitle !== null) return 1;
      if (a.projectTitle !== null && b.projectTitle === null) return -1;
      return (
        (a.projectTitle ?? "").localeCompare(b.projectTitle ?? "", "de") ||
        a.entityTitle.localeCompare(b.entityTitle, "de") ||
        a.entityType.localeCompare(b.entityType) ||
        a.entityId - b.entityId
      );
    },
  );
}
