import type {
  Agenda,
  AgendaInterventionFocus,
  ContextAvailability,
  ProjectAgendaBucket,
  ProjectAgendaEntry,
} from "@machbar/shared";
import { calendarDateForInstant } from "@machbar/shared";
import type { Graph } from "./graph.js";
import type { TaskRecord } from "./graph.js";
import { createAgendaSelection, taskDescendantIds } from "./agendaSelection.js";
import {
  pruneProjectForCompiledView,
  pruneReferenceContainers,
} from "./compiledViewProjection.js";

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

export interface BuildAgendaOptions {
  dueSoonDays?: number;
  /** Browser-local calendar date used consistently for task and project boundaries. */
  today?: string;
  now?: string;
  householdTimezone?: string;
  /**
   * The currently selected household member. When provided, every bucket
   * (including `revisit`) is restricted to tasks whose *effective* owner is
   * either this member or nobody (shared/"Gemeinsam"). When omitted, the
   * agenda is built for the whole household, unfiltered by owner.
   */
  memberId?: number;
  scope?: "mine" | "all" | "work";
  /**
   * The Heute standing-focus intervention section (§6), computed by the caller
   * from the goals journal. Kept as an injected option rather than derived here
   * because interventions live outside the task graph; defaults to empty so the
   * agenda never fails when the feature has no data.
   */
  interventions?: AgendaInterventionFocus;
  contextAvailability?: (
    task: TaskRecord,
    target: number | "household",
  ) => ContextAvailability;
}

/**
 * Builds the "Heute" (today) agenda. Categories are mutually exclusive:
 * a task is placed in the first matching bucket in the order
 * overdue > dueToday > planned > revisit > dueSoon > shared > unscheduled, so
 * nothing is duplicated across sections. The final bucket keeps actionable
 * work assigned to the selected member visible even when it has no
 * `scheduledDate`; unassigned actionable work has already been claimed by
 * `shared`.
 *
 * Captured tasks that still need clarification are excluded from every
 * bucket. Attention and explicit plans remain visible even when a task is
 * blocked or its physical context is unavailable: overdue/due-soon deadlines,
 * scheduled work, and reached revisits all need a decision. An external wait
 * with a retained historical schedule is excluded from planned work. Ordinary
 * automatic work recommendations still require executable tasks and available
 * context.
 *
 * `createAgendaSelection()` centralizes how `options.memberId` restricts every
 * bucket, revisit included, to the selected member's own and shared tasks.
 */
export function buildAgenda(
  graph: Graph,
  options: BuildAgendaOptions = {},
): Agenda {
  const nowInstant = options.now ?? new Date().toISOString();
  const {
    dueSoonDays = 3,
    memberId,
    householdTimezone,
    today = calendarDateForInstant(nowInstant, householdTimezone ?? "UTC")!,
  } = options;
  const sortByRevisitThenPriorityTitleId = sortByDateThenPriorityTitleId(
    (task) =>
      calendarDateForInstant(task.revisitAt, householdTimezone) ??
      null,
  );
  const now = Date.parse(nowInstant);
  const selection = createAgendaSelection(graph, { ...options, now: nowInstant, executionDate: today });
  const { contextAvailability, isContextAvailable } = selection;
  const soonLimit = addDaysIso(today, dueSoonDays);
  const seen = new Set<number>();

  const take = (
    predicate: (t: TaskRecord) => boolean,
    compare: (a: TaskRecord, b: TaskRecord) => number,
    options: {
      requireExecutable?: boolean;
      requireContextAvailable?: boolean;
    } = {},
  ): TaskRecord[] => {
    const requireExecutable = options.requireExecutable ?? true;
    const requireContextAvailable = options.requireContextAvailable ?? true;
    const results = graph
      .allTasks()
      .filter(
        (t) =>
          selection.isAgendaTask(t) &&
          (requireExecutable || t.status === "actionable") &&
          (!requireExecutable || t.executable) &&
          (!requireContextAvailable || isContextAvailable(t)) &&
          !seen.has(t.id) &&
          predicate(t),
      )
      .sort(compare);
    for (const t of results) seen.add(t.id);
    return results;
  };

  const overdue = take(
    (t) => !!t.dueDate && t.dueDate < today,
    sortByDueThenPriorityTitleId,
    { requireExecutable: false, requireContextAvailable: false },
  );
  const dueToday = take(
    (t) => t.dueDate === today,
    sortByDueThenPriorityTitleId,
    { requireExecutable: false, requireContextAvailable: false },
  );
  const planned = take(
    (t) =>
      t.status === "actionable" &&
      !!t.scheduledDate &&
      t.scheduledDate <= today &&
      t.externalWait === null && selection.isWindowAvailable(t),
    sortByScheduledThenPriorityTitleId,
    { requireExecutable: false, requireContextAvailable: false },
  );
  const revisit = graph
    .allTasks()
    .filter((t) => {
      const attentionDate =
        calendarDateForInstant(t.revisitAt, householdTimezone) ??
        null;
      const reached =
        attentionDate !== null &&
        (attentionDate < today ||
          (attentionDate === today &&
            t.revisitAt !== null &&
            t.revisitAt !== undefined &&
            Date.parse(t.revisitAt) <= now));
      return selection.isAgendaTask(t) && reached &&
        (t.externalWait !== null || selection.isWindowAvailable(t)) && !seen.has(t.id);
    })
    .sort(sortByRevisitThenPriorityTitleId);
  for (const task of revisit) seen.add(task.id);
  const dueSoon = take(
    (t) => !!t.dueDate && t.dueDate > today && t.dueDate <= soonLimit,
    sortByDueThenPriorityTitleId,
    { requireExecutable: false, requireContextAvailable: false },
  );
  // Attention roots own eligible embedded work. Other attention roots remain
  // separate rows; ordinary descendants must not be duplicated in ready lanes.
  const attentionRoots = [...overdue, ...dueToday, ...planned, ...revisit, ...dueSoon];
  const attentionRootIds = new Set(attentionRoots.map((task) => task.id));
  const coveredIds = new Set([
    ...attentionRootIds, ...attentionRoots.flatMap(taskDescendantIds),
  ]);
  const availableWork = selection.availableWork(coveredIds);
  const shared = availableWork.shared.filter((task) => !seen.has(task.id));
  const unscheduled = availableWork.unscheduled.filter((task) => !seen.has(task.id));
  for (const task of [...shared, ...unscheduled]) seen.add(task.id);
  const completedToday = graph
    .allTasks()
    .filter(
      (task) =>
        task.status === "done" &&
        task.completedAt?.slice(0, 10) === today &&
        selection.matchesOwner(task) &&
        selection.matchesScope(task),
    )
    .sort(
      (a, b) =>
        (b.completedAt ?? "").localeCompare(a.completedAt ?? "") ||
        sortByPriorityTitleId(a, b),
    )
    // Keep this projection flat: a completed child can be reactivated
    // independently, and embedding its whole subtree would duplicate rows.
    .map((task) => ({ ...task, children: [] }));

  const projectDueLimit = addDaysIso(today, 7);
  // Attention eligibility belongs to the root; every embedded execution row
  // uses the same eligibility as an independent Today recommendation.
  const todayProjection = { promoteUnavailableChildren: true };
  const pruneTask = (task: TaskRecord | null): TaskRecord | null =>
    task && selection.isExecutableWork(task)
      ? pruneReferenceContainers(task, selection.isExecutableWork, todayProjection) : null;
  const pruneAttentionTask = (task: TaskRecord): TaskRecord =>
    pruneReferenceContainers(task, selection.isExecutableWork, {
      ...todayProjection, excludedSubtrees: attentionRootIds,
    });
  const stuckByProject = new Map(
    graph.listStuckProjects().map((project) => [project.id, project]),
  );
  const projects = [...graph.projectsById.values()]
    .filter(
      (project) =>
        project.status === "active" &&
        (memberId === undefined ||
          project.ownerMemberId === null ||
          project.ownerMemberId === memberId) &&
        selection.matchesScope(project),
    )
    .flatMap((project): ProjectAgendaEntry[] => {
      const due =
        project.dueDate !== null && project.dueDate <= projectDueLimit;
      if (!due) return [];

      const attentionBucket: ProjectAgendaBucket =
        project.dueDate! < today
          ? "overdue"
          : project.dueDate === today
            ? "dueToday"
            : "dueSoon";

      const computed = graph.projectWithComputed(project.id);
      if (!computed) return [];
      const availableNextAction = graph.selectedNextActionsFor(
        project.id,
        selection.laneSelection,
        selection.isExecutionSuggestion,
      )[0] ?? null;
      const canonicalNextAction = graph.nextActionFor(project.id);
      const nextAction = availableNextAction;
      const additionalNextActions = graph.additionalSelectedNextActionsFor(
        project.id,
        selection.laneSelection,
        selection.isExecutionSuggestion,
      );
      const projectForAgenda = pruneProjectForCompiledView({
        ...computed,
        nextAction: pruneTask(nextAction),
        deferredNextAction: pruneTask(computed.deferredNextAction ?? null),
        additionalNextActions: computed.additionalNextActions ?? [],
      }, selection.isExecutableWork, todayProjection);
      const stuckProject = canonicalNextAction
        ? undefined
        : stuckByProject.get(project.id);
      return [
        {
          project: projectForAgenda,
          qualification: "due",
          attentionBucket,
          nextAction: pruneTask(nextAction),
          nextActionContextAvailability: nextAction
            ? contextAvailability(nextAction)
            : null,
          additionalNextActions: additionalNextActions.flatMap((task) => {
            const projected = pruneTask(task);
            return projected ? [projected] : [];
          }),
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
    planned: planned.map(pruneAttentionTask),
    overdue: overdue.map(pruneAttentionTask),
    dueToday: dueToday.map(pruneAttentionTask),
    dueSoon: dueSoon.map(pruneAttentionTask),
    shared: shared.map(pruneAttentionTask),
    unscheduled: unscheduled.map(pruneAttentionTask),
    revisit: revisit.map(pruneAttentionTask),
    completedToday,
    projects,
    interventions: options.interventions ?? { running: [], review: [] },
  };
}
