import type {
  WeekAgenda,
  WeekWorkItemPlacement,
  WeekWorkItemSummary,
} from "@machbar/shared";
import type { Graph, ProjectRecord, TaskRecord } from "./graph.js";
import { isTaskInWorkingSystem } from "./workEligibility.js";

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isOpenTask(task: TaskRecord): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

function isOpenStory(story: ProjectRecord): boolean {
  return story.status !== "completed" && story.status !== "archived";
}

function matchesSelectedOwner(
  ownerId: number | null,
  memberId?: number,
): boolean {
  return memberId === undefined || ownerId === null || ownerId === memberId;
}

function compareItems(
  a: WeekWorkItemSummary,
  b: WeekWorkItemSummary,
): number {
  const placementDate = (item: WeekWorkItemSummary) => {
    if (item.placement === "scheduled") return item.scheduledDate;
    if (item.placement === "revisit") return item.externalWait?.revisitDate;
    return item.dueDate;
  };
  const dateA = placementDate(a) ?? "9999-99-99";
  const dateB = placementDate(b) ?? "9999-99-99";
  if (dateA !== dateB) return dateA.localeCompare(dateB);
  const placementOrder: Record<WeekWorkItemPlacement, number> = {
    scheduled: 0,
    revisit: 1,
    due: 2,
    unplanned: 3,
  };
  if (a.placement !== b.placement) {
    return placementOrder[a.placement] - placementOrder[b.placement];
  }
  if (a.role !== b.role) return a.role === "story" ? -1 : 1;
  return a.title.localeCompare(b.title, "de") || a.id - b.id;
}

function taskSummary(
  task: TaskRecord,
  graph: Graph,
  placement: WeekWorkItemPlacement,
): WeekWorkItemSummary {
  const parent =
    task.parentTaskId !== null ? graph.tasksById.get(task.parentTaskId) ?? null : null;
  return {
    id: task.id,
    revision: task.revision,
    role: "task",
    title: task.title,
    status: task.status,
    ownerMemberId: task.effectiveOwnerId,
    scheduledDate: task.scheduledDate,
    dueDate: task.dueDate,
    externalWait: task.externalWait,
    placement,
    projectId: task.projectId,
    projectTitle: task.projectTitle ?? null,
    parentId: task.parentTaskId,
    parentTitle: parent?.title ?? null,
    tags: task.effectiveTags,
    contexts: task.effectiveContexts,
    blocked: task.blocked,
    executable: task.executable,
    stuckReason: null,
    task,
    project: null,
  };
}

function storySummary(
  story: ProjectRecord,
  graph: Graph,
  placement: WeekWorkItemPlacement,
): WeekWorkItemSummary {
  const parent =
    story.parentId !== null ? graph.projectsById.get(story.parentId) ?? null : null;
  return {
    id: story.id,
    revision: story.revision,
    role: "story",
    title: story.title,
    status: story.status,
    ownerMemberId: story.ownerMemberId,
    scheduledDate: story.scheduledDate,
    dueDate: story.dueDate,
    externalWait: null,
    placement,
    projectId: story.id,
    projectTitle: story.title,
    parentId: story.parentId,
    parentTitle: parent?.title ?? null,
    tags: story.effectiveTags,
    contexts: story.contexts,
    blocked: story.stuckReason !== null,
    executable: story.nextAction !== null,
    stuckReason: story.stuckReason ?? null,
    task: null,
    project: story,
  };
}

export interface BuildWeekAgendaOptions {
  start: string;
  memberId?: number;
}

export function buildWeekAgenda(
  graph: Graph,
  options: BuildWeekAgendaOptions,
): WeekAgenda {
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: addDaysIso(options.start, index),
    items: [] as WeekWorkItemSummary[],
  }));
  const dateSet = new Set(days.map((day) => day.date));
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  const projectStatusById = new Map(
    [...graph.projectsById.values()].map((project) => [
      project.id,
      project.status,
    ]),
  );
  const unplanned: WeekWorkItemSummary[] = [];

  const place = (item: WeekWorkItemSummary) => {
    if (item.placement === "scheduled" && item.scheduledDate) {
      dayByDate.get(item.scheduledDate)?.items.push(item);
      return;
    }
    if (item.placement === "due" && item.dueDate) {
      dayByDate.get(item.dueDate)?.items.push(item);
      return;
    }
    if (item.placement === "revisit" && item.externalWait?.revisitDate) {
      dayByDate.get(item.externalWait.revisitDate)?.items.push(item);
      return;
    }
    unplanned.push(item);
  };

  for (const task of graph.allTasks()) {
    if (
      !isOpenTask(task) ||
      task.status !== "actionable" ||
      task.needsClarification ||
      !isTaskInWorkingSystem(task, projectStatusById) ||
      !matchesSelectedOwner(task.effectiveOwnerId, options.memberId)
    ) {
      continue;
    }
    if (task.externalWait) {
      if (
        task.externalWait.revisitDate &&
        dateSet.has(task.externalWait.revisitDate)
      ) {
        place(taskSummary(task, graph, "revisit"));
      } else if (task.dueDate && dateSet.has(task.dueDate)) {
        place(taskSummary(task, graph, "due"));
      }
    } else if (task.scheduledDate && dateSet.has(task.scheduledDate)) {
      place(taskSummary(task, graph, "scheduled"));
    } else if (task.dueDate && dateSet.has(task.dueDate)) {
      place(taskSummary(task, graph, "due"));
    } else if (!task.scheduledDate && task.executable) {
      place(taskSummary(task, graph, "unplanned"));
    }
  }

  for (const story of graph.listProjectsWithComputed()) {
    if (!isOpenStory(story) || !matchesSelectedOwner(story.ownerMemberId, options.memberId)) {
      continue;
    }
    if (story.scheduledDate && dateSet.has(story.scheduledDate)) {
      place(storySummary(story, graph, "scheduled"));
    } else if (story.dueDate && dateSet.has(story.dueDate)) {
      place(storySummary(story, graph, "due"));
    } else if (!story.scheduledDate) {
      place(storySummary(story, graph, "unplanned"));
    }
  }

  for (const day of days) day.items.sort(compareItems);
  unplanned.sort(compareItems);

  return {
    start: days[0]!.date,
    end: days[6]!.date,
    days,
    unplanned,
  };
}
