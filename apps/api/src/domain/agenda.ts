import type {
  Agenda,
  ProjectAgendaEntry,
} from "@machbar/shared";
import type { Graph } from "./graph.js";
import type { TaskRecord } from "./graph.js";
import { isTaskInWorkingSystem } from "./workEligibility.js";

function isOpen(t: TaskRecord): boolean {
  return t.status !== "done" && t.status !== "cancelled";
}

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
const sortByDueThenPriorityTitleId = sortByDateThenPriorityTitleId(
  (task) => task.dueDate,
);

/**
 * A task belongs to the requesting member's agenda when it's owned by them
 * (via the *effective*, inheritance-resolved owner — never the raw/explicit
 * `ownerMemberId`) or when it has no owner at all (`effectiveOwnerId ===
 * null`, i.e. "Gemeinsam"/offen, shared across the household).
 *
 * When `memberId` is omitted entirely, no owner filtering is applied at
 * all, preserving the previous all-household response shape for API
 * clients that don't yet pass a selected member.
 */
function matchesSelectedOwner(t: TaskRecord, memberId?: number): boolean {
  if (memberId === undefined) return true;
  return t.effectiveOwnerId === null || t.effectiveOwnerId === memberId;
}

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
 * `revisit`: a blocked task
 * whose own `scheduledDate` (never inherited from a project or parent) is
 * today or earlier reappears there as a reminder that it's worth checking
 * on, even though it can't be worked on directly yet.
 *
 * See {@link matchesSelectedOwner} for how `options.memberId` restricts
 * every bucket, revisit included, to the selected member's own and shared
 * tasks.
 */
export function buildAgenda(
  graph: Graph,
  options: BuildAgendaOptions = {},
): Agenda {
  const { dueSoonDays = 3, memberId, today = todayIso() } = options;
  const scope = options.scope ?? (memberId === undefined ? "all" : "mine");
  const soonLimit = addDaysIso(today, dueSoonDays);
  const seen = new Set<number>();
  const projectStatusById = new Map(
    [...graph.projectsById.values()].map((project) => [
      project.id,
      project.status,
    ]),
  );
  const isOperationalTask = (task: TaskRecord) =>
    isTaskInWorkingSystem(task, projectStatusById);
  const selectedProjectTaskIds = new Set(
    [...graph.projectsById.values()]
      .filter((project) => project.status === "active")
      .flatMap((project) =>
        graph
          .todayNextActionsFor(
            project.id,
            scope === "mine" && memberId !== undefined
              ? { scope: "mine", memberId }
              : { scope: "all" },
          )
          .map((task) => task.id),
      ),
  );
  const isSelectedOrdinaryWork = (task: TaskRecord) =>
    task.projectId === null || selectedProjectTaskIds.has(task.id);

  const take = (
    predicate: (t: TaskRecord) => boolean,
    compare: (a: TaskRecord, b: TaskRecord) => number,
  ): TaskRecord[] => {
    const results = graph
      .allTasks()
      .filter(
        (t) =>
          isOpen(t) &&
          isOperationalTask(t) &&
          t.executable &&
          !seen.has(t.id) &&
          matchesSelectedOwner(t, memberId) &&
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
        isOpen(t) &&
        isOperationalTask(t) &&
        t.blocked &&
        !!t.scheduledDate &&
        t.scheduledDate <= today &&
        matchesSelectedOwner(t, memberId),
    )
    .sort(sortByScheduledThenPriorityTitleId);
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
  const shared = take(
    (t) =>
      t.status === "actionable" &&
      t.effectiveOwnerId === null &&
      !t.scheduledDate &&
      isSelectedOrdinaryWork(t),
    sortByPriorityTitleId,
  );
  const unscheduled = take(
    (t) =>
      t.status === "actionable" &&
      t.effectiveOwnerId !== null &&
      !t.scheduledDate &&
      isSelectedOrdinaryWork(t),
    sortByPriorityTitleId,
  );

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
      const nextAction = graph.nextActionFor(project.id);
      const stuckProject = nextAction
        ? undefined
        : stuckByProject.get(project.id);
      return [
        {
          project: computed,
          qualification: due && scheduled ? "both" : due ? "due" : "scheduled",
          nextAction,
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
