import type {
  ContextAvailability,
  WaitingEntry,
  WaitingReason,
} from "@machbar/shared";
import type { Graph, TaskRecord } from "./graph.js";
import { isTaskInWorkingSystem } from "./workEligibility.js";

export interface BuildWaitingOptions {
  memberId?: number;
  scope: "mine" | "all";
  contextAvailability: (
    task: TaskRecord,
    target: number | "household",
  ) => ContextAvailability;
}

function matchesScope(
  task: TaskRecord,
  memberId: number | undefined,
  scope: "mine" | "all",
): boolean {
  return (
    scope === "all" ||
    memberId === undefined ||
    task.effectiveOwnerId === null ||
    task.effectiveOwnerId === memberId
  );
}

export function buildWaitingEntries(
  graph: Graph,
  options: BuildWaitingOptions,
): WaitingEntry[] {
  const projectStatusById = new Map(
    [...graph.projectsById.values()].map((project) => [
      project.id,
      project.status,
    ]),
  );

  return graph
    .allTasks()
    .filter(
      (task) =>
        task.status === "actionable" &&
        isTaskInWorkingSystem(task, projectStatusById) &&
        matchesScope(task, options.memberId, options.scope),
    )
    .flatMap((task): WaitingEntry[] => {
      const reasons: WaitingReason[] = [];
      if (task.externalWait) {
        reasons.push({
          type: "external",
          waitingFor: task.externalWait.waitingFor,
          revisitDate: task.externalWait.revisitDate,
        });
      } else if (task.executable && task.effectiveContexts.length > 0) {
        const target =
          task.effectiveOwnerId ??
          (options.scope === "mine" && options.memberId !== undefined
            ? options.memberId
            : "household");
        const availability = options.contextAvailability(task, target);
        if (availability.status === "unavailable") {
          reasons.push({
            type: "context",
            contexts: availability.missingContexts,
          });
        }
      }
      return reasons.length > 0 ? [{ task, reasons }] : [];
    })
    .sort((a, b) => {
      const externalA = a.reasons.find((reason) => reason.type === "external");
      const externalB = b.reasons.find((reason) => reason.type === "external");
      const attentionA =
        externalA?.type === "external"
          ? externalA.revisitDate ?? "9999-99-99"
          : "9999-99-99";
      const attentionB =
        externalB?.type === "external"
          ? externalB.revisitDate ?? "9999-99-99"
          : "9999-99-99";
      return (
        attentionA.localeCompare(attentionB) ||
        (a.task.dueDate ?? "9999-99-99").localeCompare(
          b.task.dueDate ?? "9999-99-99",
        ) ||
        a.task.title.localeCompare(b.task.title, "de") ||
        a.task.id - b.task.id
      );
    });
}
