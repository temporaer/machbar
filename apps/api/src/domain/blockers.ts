import type { ProjectStatus, TaskStatus } from "@machbar/shared";

export type BlockerPathReason =
  | "captured"
  | "someday"
  | "backlog_project"
  | "terminal_project"
  | "waiting_without_followup"
  | "followup_due"
  | "cycle"
  | "missing_task";

export interface BlockerTaskInput {
  id: number;
  title: string;
  status: TaskStatus;
  projectId: number | null;
  scheduledDate: string | null;
  externalWait: { waitingFor: string | null } | null;
  dependencies: Array<{
    dependsOnTaskId: number;
    resolved: boolean;
  }>;
}

export interface BlockerPathDiagnosis {
  reason: BlockerPathReason;
  targetTaskId: number;
  path: number[];
}

export interface TaskBlockerAnalysis {
  blocked: boolean;
  executable: boolean;
  healthyProgressPath: boolean;
  nextBlockerAttentionDate: string | null;
  diagnoses: BlockerPathDiagnosis[];
}

interface PathAnalysis {
  healthy: boolean;
  attentionDate: string | null;
  diagnoses: BlockerPathDiagnosis[];
}

function earliestDate(values: Array<string | null>): string | null {
  return values
    .filter((value): value is string => value !== null && value.trim() !== "")
    .sort()[0] ?? null;
}

/**
 * Canonical execution and blocker-path model.
 *
 * The analyzer deliberately accepts plain snapshots instead of importing
 * Graph. That keeps Graph, repository adapters, Agenda, Stuck, and
 * Refinement from forming circular dependencies while still sharing one
 * decision model.
 */
export function analyzeTaskBlockers(
  tasks: ReadonlyMap<number, BlockerTaskInput>,
  projectStatuses: ReadonlyMap<number, ProjectStatus>,
  today: string,
): Map<number, TaskBlockerAnalysis> {
  const analyzePath = (
    taskId: number,
    stack: readonly number[],
  ): PathAnalysis => {
    const task = tasks.get(taskId);
    if (!task) {
      return {
        healthy: false,
        attentionDate: null,
        diagnoses: [
          {
            reason: "missing_task",
            targetTaskId: taskId,
            path: [...stack, taskId],
          },
        ],
      };
    }
    if (stack.includes(taskId)) {
      return {
        healthy: false,
        attentionDate: null,
        diagnoses: [
          {
            reason: "cycle",
            targetTaskId: taskId,
            path: [...stack, taskId],
          },
        ],
      };
    }

    const path = [...stack, taskId];
    const projectStatus =
      task.projectId === null ? null : projectStatuses.get(task.projectId);
    if (projectStatus === "backlog") {
      return {
        healthy: false,
        attentionDate: null,
        diagnoses: [
          {
            reason: "backlog_project",
            targetTaskId: task.id,
            path,
          },
        ],
      };
    }
    if (projectStatus === "completed" || projectStatus === "archived") {
      return {
        healthy: false,
        attentionDate: null,
        diagnoses: [
          {
            reason: "terminal_project",
            targetTaskId: task.id,
            path,
          },
        ],
      };
    }
    if (task.status === "captured") {
      return {
        healthy: false,
        attentionDate: null,
        diagnoses: [{ reason: "captured", targetTaskId: task.id, path }],
      };
    }
    if (task.status === "someday") {
      return {
        healthy: false,
        attentionDate: null,
        diagnoses: [{ reason: "someday", targetTaskId: task.id, path }],
      };
    }
    if (task.status === "done" || task.status === "cancelled") {
      return { healthy: true, attentionDate: null, diagnoses: [] };
    }

    const branchResults: PathAnalysis[] = [];
    if (task.externalWait) {
      if (!task.scheduledDate) {
        branchResults.push({
          healthy: false,
          attentionDate: null,
          diagnoses: [
            {
              reason: "waiting_without_followup",
              targetTaskId: task.id,
              path,
            },
          ],
        });
      } else if (task.scheduledDate <= today) {
        branchResults.push({
          healthy: false,
          attentionDate: task.scheduledDate,
          diagnoses: [
            {
              reason: "followup_due",
              targetTaskId: task.id,
              path,
            },
          ],
        });
      } else {
        branchResults.push({
          healthy: true,
          attentionDate: task.scheduledDate,
          diagnoses: [],
        });
      }
    }

    for (const dependency of task.dependencies) {
      if (dependency.resolved) continue;
      branchResults.push(analyzePath(dependency.dependsOnTaskId, path));
    }

    if (branchResults.length === 0) {
      return {
        healthy: true,
        attentionDate: task.scheduledDate,
        diagnoses: [],
      };
    }

    return {
      healthy: branchResults.every((branch) => branch.healthy),
      attentionDate: earliestDate(
        branchResults.map((branch) => branch.attentionDate),
      ),
      diagnoses: branchResults.flatMap((branch) => branch.diagnoses),
    };
  };

  const result = new Map<number, TaskBlockerAnalysis>();
  for (const task of tasks.values()) {
    const unresolvedDependencies = task.dependencies.some(
      (dependency) => !dependency.resolved,
    );
    const blocked =
      task.status === "actionable" &&
      (task.externalWait !== null || unresolvedDependencies);
    const path = analyzePath(task.id, []);
    result.set(task.id, {
      blocked,
      executable: task.status === "actionable" && !blocked,
      healthyProgressPath: path.healthy,
      nextBlockerAttentionDate: blocked ? path.attentionDate : null,
      diagnoses: path.diagnoses,
    });
  }
  return result;
}
