import type { ContextAvailability, ProjectStatus } from "@machbar/shared";
import type { Graph, TaskRecord } from "./graph.js";
import { isTaskInWorkingSystem } from "./workEligibility.js";

export type AgendaScope = "mine" | "all";
export type AgendaLaneSelection =
  | { scope: "mine"; memberId: number }
  | { scope: "all" };

export interface AgendaSelectionOptions {
  memberId?: number;
  scope?: AgendaScope;
  ignoreContextAvailability?: boolean;
  contextAvailability?: (
    task: TaskRecord,
    target: number | "household",
  ) => ContextAvailability;
}

export interface CurrentAvailableWorkOptions extends AgendaSelectionOptions {
  today: string;
  dueSoonDays?: number;
}

export interface AgendaAvailableWork {
  shared: TaskRecord[];
  unscheduled: TaskRecord[];
}

export function isOpenTask(task: TaskRecord): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

function sortByPriorityTitleId(a: TaskRecord, b: TaskRecord): number {
  const prA = a.priority ?? Number.POSITIVE_INFINITY;
  const prB = b.priority ?? Number.POSITIVE_INFINITY;
  if (prA !== prB) return prA - prB;
  return a.title.localeCompare(b.title, "de") || a.id - b.id;
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function descendantIds(task: TaskRecord): number[] {
  const ids: number[] = [];
  const walk = (children: TaskRecord[]) => {
    for (const child of children) {
      ids.push(child.id);
      if (child.children.length > 0) walk(child.children);
    }
  };
  walk(task.children);
  return ids;
}

export function createAgendaSelection(
  graph: Graph,
  options: AgendaSelectionOptions = {},
) {
  const { memberId } = options;
  const scope = options.scope ?? (memberId === undefined ? "all" : "mine");
  const laneSelection: AgendaLaneSelection =
    scope === "mine" && memberId !== undefined
      ? { scope: "mine", memberId }
      : { scope: "all" };
  const projectStatusById = new Map<number, ProjectStatus>(
    [...graph.projectsById.values()].map((project) => [
      project.id,
      project.status,
    ]),
  );
  const contextAvailability = (task: TaskRecord): ContextAvailability => {
    if (options.ignoreContextAvailability) {
      return { status: "available", availableNow: true, missingContexts: [] };
    }
    const target =
      task.effectiveOwnerId ??
      (scope === "mine" && memberId !== undefined ? memberId : "household");
    return (
      options.contextAvailability?.(task, target) ?? {
        status: "available",
        availableNow: true,
        missingContexts: [],
      }
    );
  };
  const isContextAvailable = (task: TaskRecord) =>
    contextAvailability(task).status !== "unavailable";
  const matchesOwnerId = (ownerId: number | null) =>
    memberId === undefined ||
    ownerId === null ||
    ownerId === memberId;
  const matchesOwner = (task: TaskRecord) => matchesOwnerId(task.effectiveOwnerId);
  const isOperationalTask = (task: TaskRecord) =>
    isTaskInWorkingSystem(task, projectStatusById);
  const isAgendaTask = (task: TaskRecord) =>
    isOpenTask(task) &&
    task.status === "actionable" &&
    !task.needsClarification &&
    isOperationalTask(task) &&
    matchesOwner(task);
  const selectedProjectTaskIds = new Set(
    [...graph.projectsById.values()]
      .filter((project) => project.status === "active")
      .flatMap((project) =>
        graph
          .selectedNextActionsFor(project.id, laneSelection, isContextAvailable)
          .map((task) => task.id),
      ),
  );
  const isSelectedOrdinaryWork = (task: TaskRecord) =>
    task.projectId === null || selectedProjectTaskIds.has(task.id);
  const isExecutableWork = (task: TaskRecord) =>
    isAgendaTask(task) &&
    task.executable &&
    isContextAvailable(task) &&
    isSelectedOrdinaryWork(task);
  const isDirectExternalWaitAttention = (task: TaskRecord) =>
    isAgendaTask(task) && task.blocked && task.externalWait !== null;
  const availableWork = (
    excludedIds: ReadonlySet<number> = new Set(),
  ): AgendaAvailableWork => {
    const available = graph
      .allTasks()
      .filter(
        (task) =>
          !excludedIds.has(task.id) &&
          !task.scheduledDate &&
          isExecutableWork(task),
      )
      .sort(sortByPriorityTitleId);
    return {
      shared: available.filter((task) => task.effectiveOwnerId === null),
      unscheduled: available.filter((task) => task.effectiveOwnerId !== null),
    };
  };

  return {
    scope,
    memberId,
    laneSelection,
    contextAvailability,
    isContextAvailable,
    matchesOwnerId,
    matchesOwner,
    isOperationalTask,
    isAgendaTask,
    isExecutableWork,
    isSelectedOrdinaryWork,
    isDirectExternalWaitAttention,
    availableWork,
  };
}

export function selectCurrentAvailableWork(
  graph: Graph,
  options: CurrentAvailableWorkOptions,
): AgendaAvailableWork {
  const selection = createAgendaSelection(graph, options);
  const soonLimit = addDaysIso(options.today, options.dueSoonDays ?? 3);
  const takenByCurrentAttention = new Set<number>();

  for (const task of graph.allTasks()) {
    if (
      selection.isDirectExternalWaitAttention(task) &&
      task.externalWait?.revisitDate &&
      task.externalWait.revisitDate <= options.today
    ) {
      takenByCurrentAttention.add(task.id);
      for (const descendantId of descendantIds(task)) {
        takenByCurrentAttention.add(descendantId);
      }
      continue;
    }
    if (
      selection.isAgendaTask(task) &&
      task.executable &&
      selection.isContextAvailable(task) &&
      ((task.status === "actionable" &&
        !!task.scheduledDate &&
        task.scheduledDate <= options.today) ||
        (!!task.dueDate && task.dueDate <= soonLimit))
    ) {
      takenByCurrentAttention.add(task.id);
      for (const descendantId of descendantIds(task)) {
        takenByCurrentAttention.add(descendantId);
      }
    }
  }

  return selection.availableWork(takenByCurrentAttention);
}
