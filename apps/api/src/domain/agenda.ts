import type {
  Agenda,
  ContextAvailability,
  ProjectAgendaEntry,
} from "@machbar/shared";
import type { Graph } from "./graph.js";
import type { TaskRecord } from "./graph.js";
import {
  createAgendaSelection,
  selectCurrentAvailableWork,
} from "./agendaSelection.js";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sortByPriorityTitleId(a: TaskRecord, b: TaskRecord): number {
  const prA = a.priority ?? Number.POSITIVE_INFINITY;
  const prB = b.priority ?? Number.POSITIVE_INFINITY;
  if (prA !== prB) return prA - prB;
  return a.title.localeCompare(b.title, "de") || a.id - b.id;
}

function sortByDateThenPriorityTitleId(
  date: (task: TaskRecord) => string | null,
): (a: TaskRecord, b: TaskRecord) => number {
  return (a, b) => {
    const dateA = date(a) ?? "9999-99-99";
    const dateB = date(b) ?? "9999-99-99";
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    return sortByPriorityTitleId(a, b);
  };
}

const sortByScheduledThenPriorityTitleId = sortByDateThenPriorityTitleId(
  (task) => task.scheduledDate,
);
const sortByRevisitThenPriorityTitleId = sortByDateThenPriorityTitleId(
  (task) => task.externalWait?.revisitDate ?? null,
);
const sortByDueThenPriorityTitleId = sortByDateThenPriorityTitleId(
  (task) => task.dueDate,
);

export interface BuildAgendaOptions {
  dueSoonDays?: number;
  /** Browser-local calendar date used consistently for task and project boundaries. */
  today?: string;
  /**
   * The currently selected household member. When provided, every bucket
   * (including `revisit`) is restricted to tasks whose *effective* owner is
   * either this member or nobody (shared/"Gemeinsam"). When omitted, the
   * agenda is built for the whole household, unfiltered by owner.
   */
  memberId?: number;
  scope?: "mine" | "all";
  contextAvailability?: (
    task: TaskRecord,
    target: number | "household",
  ) => ContextAvailability;
}

/**
 * Builds the "Heute" (today) agenda. Categories are mutually exclusive:
 * a task is placed in the first matching bucket in the order
 * revisit > planned > overdue > dueToday > dueSoon > shared > unscheduled, so
 * nothing is duplicated across sections. The final bucket keeps actionable
 * work assigned to the selected member visible even when it has no
 * `scheduledDate`; unassigned actionable work has already been claimed by
 * `shared`.
 *
 * Captured tasks that still need clarification are excluded from every
 * bucket. Among clarified work, blocked tasks (unresolved dependencies)
 * are normally excluded from every bucket above — they aren't actionable,
 * so surfacing them in "Heute" would just be noise. The one exception is
 * `revisit`: a task with a direct external wait whose revisit date is today
 * or earlier reappears as a reminder to check on it.
 *
 * `createAgendaSelection()` centralizes how `options.memberId` restricts every
 * bucket, revisit included, to the selected member's own and shared tasks.
 */
export function buildAgenda(
  graph: Graph,
  options: BuildAgendaOptions = {},
): Agenda {
  const { dueSoonDays = 3, memberId, today = todayIso() } = options;
  const selection = createAgendaSelection(graph, options);
  const { contextAvailability, isContextAvailable } = selection;
  const soonLimit = addDaysIso(today, dueSoonDays);
  const seen = new Set<number>();

  const take = (
    predicate: (t: TaskRecord) => boolean,
    compare: (a: TaskRecord, b: TaskRecord) => number,
  ): TaskRecord[] => {
    const results = graph
      .allTasks()
      .filter(
        (t) =>
          selection.isAgendaTask(t) &&
          t.executable &&
          isContextAvailable(t) &&
          !seen.has(t.id) &&
          predicate(t),
      )
      .sort(compare);
    for (const t of results) seen.add(t.id);
    return results;
  };

  const revisit = graph
    .allTasks()
    .filter(
      (t) =>
        selection.isDirectExternalWaitAttention(t) &&
        !!t.externalWait?.revisitDate &&
        t.externalWait.revisitDate <= today,
    )
    .sort(sortByRevisitThenPriorityTitleId);
  for (const task of revisit) seen.add(task.id);
  const planned = take(
    (t) =>
      t.status === "actionable" &&
      !!t.scheduledDate &&
      t.scheduledDate <= today,
    sortByScheduledThenPriorityTitleId,
  );
  const overdue = take(
    (t) => !!t.dueDate && t.dueDate < today,
    sortByDueThenPriorityTitleId,
  );
  const dueToday = take(
    (t) => t.dueDate === today,
    sortByDueThenPriorityTitleId,
  );
  const dueSoon = take(
    (t) => !!t.dueDate && t.dueDate > today && t.dueDate <= soonLimit,
    sortByDueThenPriorityTitleId,
  );
  const { shared, unscheduled } = selectCurrentAvailableWork(graph, {
    ...options,
    today,
    dueSoonDays,
  });
  for (const task of [...shared, ...unscheduled]) seen.add(task.id);

  const projectDueLimit = addDaysIso(today, 7);
  const stuckByProject = new Map(
    graph.listStuckProjects().map((project) => [project.id, project]),
  );
  const projects = [...graph.projectsById.values()]
    .filter(
      (project) =>
        project.status === "active" &&
        (memberId === undefined ||
          project.ownerMemberId === null ||
          project.ownerMemberId === memberId),
    )
    .flatMap((project): ProjectAgendaEntry[] => {
      const due =
        project.dueDate !== null && project.dueDate <= projectDueLimit;
      const scheduled =
        project.scheduledDate !== null &&
        project.scheduledDate <= today;
      if (!due && !scheduled) return [];

      const computed = graph.projectWithComputed(project.id);
      if (!computed) return [];
      const availableNextAction = graph.selectedNextActionsFor(
        project.id,
        selection.laneSelection,
        isContextAvailable,
      )[0] ?? null;
      const canonicalNextAction = graph.nextActionFor(project.id);
      const nextAction = availableNextAction ?? canonicalNextAction;
      const additionalNextActions = graph.additionalSelectedNextActionsFor(
        project.id,
        selection.laneSelection,
        isContextAvailable,
      );
      const stuckProject = canonicalNextAction
        ? undefined
        : stuckByProject.get(project.id);
      return [
        {
          project: computed,
          qualification: due && scheduled ? "both" : due ? "due" : "scheduled",
          nextAction,
          nextActionContextAvailability: nextAction
            ? contextAvailability(nextAction)
            : null,
          additionalNextActions,
          stuck: stuckProject
            ? {
                reason: stuckProject.stuckReason,
              }
            : null,
        },
      ];
    })
    .sort((a, b) => {
      const aDate =
        a.qualification === "scheduled"
          ? a.project.scheduledDate
          : a.project.dueDate;
      const bDate =
        b.qualification === "scheduled"
          ? b.project.scheduledDate
          : b.project.dueDate;
      if (aDate !== bDate) return (aDate ?? "").localeCompare(bDate ?? "");
      return (
        a.project.position - b.project.position ||
        a.project.title.localeCompare(b.project.title, "de") ||
        a.project.id - b.project.id
      );
    });

  return {
    planned,
    overdue,
    dueToday,
    dueSoon,
    shared,
    unscheduled,
    revisit,
    projects,
  };
}
