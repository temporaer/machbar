import type {
  CleanupItemContext,
  CleanupPlanningChildContext,
  CleanupPlanningContext,
  CleanupTargetType,
  WorkItemScope,
} from "@machbar/shared";
import { CLEANUP_ROUND_SAMPLE_LIMIT } from "@machbar/shared";
import type { Graph, ProjectRecord, TaskRecord } from "../domain/graph.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Items acknowledged in Review/Klärungsrunde this recently are skipped. */
export const CLEANUP_RECENT_REVIEW_DAYS = 7;
const STALENESS_HORIZON_DAYS = 60;
const MAX_PER_CLUSTER = 2;
const MAX_TITLES = 10;
const MAX_NOTES = 1_500;
const MAX_PLANNING_OPEN_CHILDREN = 8;
const MAX_PLANNING_DONE_CHILDREN = 5;
const MAX_PLANNING_WAITING_CHILDREN = 5;
const MAX_PLANNING_CHILD_NOTES = 300;

export interface CleanupSampleOptions {
  scope: WorkItemScope;
  /** `${targetType}:${targetId}` keys already in an active round. */
  excludedKeys: ReadonlySet<string>;
  now?: Date;
  random?: () => number;
  limit?: number;
}

export interface CleanupCandidate {
  targetType: CleanupTargetType;
  targetId: number;
  cluster: string;
  score: number;
}

function daysSince(iso: string | null, now: Date): number {
  if (!iso) return STALENESS_HORIZON_DAYS;
  return Math.max(0, (now.getTime() - new Date(iso).getTime()) / DAY_MS);
}

function lastTouched(item: { updatedAt: string; reviewedAt: string | null }): string {
  return item.reviewedAt && item.reviewedAt > item.updatedAt ? item.reviewedAt : item.updatedAt;
}

function recentlyReviewed(reviewedAt: string | null, now: Date): boolean {
  return reviewedAt !== null && daysSince(reviewedAt, now) < CLEANUP_RECENT_REVIEW_DAYS;
}

/** Short or one/two-word titles are often placeholders rather than actions. */
export function isVagueTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length <= 15 || trimmed.split(/\s+/).length <= 2;
}

function score(
  item: { title: string; notes: string; updatedAt: string; reviewedAt: string | null },
  childCount: number,
  now: Date,
  random: () => number,
): number {
  const staleness = Math.min(daysSince(lastTouched(item), now), STALENESS_HORIZON_DAYS) / STALENESS_HORIZON_DAYS;
  return staleness
    + (item.notes.trim() ? 0.25 : 0)
    + (childCount > 0 ? 0.25 : 0)
    + (isVagueTitle(item.title) ? 0.4 : 0)
    // Jitter keeps the long tail reachable; selection is not diagnosis.
    + random() * 0.75;
}

function titles(items: ReadonlyArray<{ title: string }>): string[] {
  return items.slice(0, MAX_TITLES).map((item) => item.title);
}

function taskChildren(graph: Graph, task: TaskRecord): TaskRecord[] {
  return (graph.childrenByParent.get(task.id) ?? []).filter(
    (child) => child.status !== "done" && child.status !== "cancelled",
  );
}

function projectChildren(graph: Graph, project: ProjectRecord): Array<{ title: string }> {
  const roots = (graph.rootsByProject.get(project.id) ?? []).filter(
    (task) => task.status !== "done" && task.status !== "cancelled",
  );
  const stories = [...graph.projectsById.values()].filter(
    (story) => story.parentId === project.id && (story.status === "active" || story.status === "backlog"),
  );
  return [...stories, ...roots];
}

function openProject(project: ProjectRecord | undefined): boolean {
  return project !== undefined && (project.status === "active" || project.status === "backlog");
}

function clipNotes(notes: string): string | null {
  const trimmed = notes.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_NOTES ? `${trimmed.slice(0, MAX_NOTES)}…` : trimmed;
}

function clipText(value: string, max: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= max) return trimmed;
  const headLength = Math.max(1, Math.floor((max - 3) * 0.65));
  const tailLength = Math.max(1, max - 3 - headLength);
  return `${trimmed.slice(0, headLength)} … ${trimmed.slice(-tailLength)}`;
}

function taskPlanningChild(task: TaskRecord): CleanupPlanningChildContext {
  const result: CleanupPlanningChildContext = { id: task.id, title: task.title };
  if (task.status !== "actionable") result.status = task.status;
  if (task.kind !== "action") result.kind = task.kind;
  if (task.blocked) result.blocked = true;
  if (task.externalWait) {
    const externalWait: NonNullable<CleanupPlanningChildContext["externalWait"]> = {};
    const label = task.externalWait.waitingFor?.trim();
    if (label) externalWait.label = label;
    if (task.externalWait.revisitDate) externalWait.revisitDate = task.externalWait.revisitDate;
    if (Object.keys(externalWait).length > 0) result.externalWait = externalWait;
  }
  if (task.scheduledDate) result.scheduledDate = task.scheduledDate;
  if (task.dueDate) result.dueDate = task.dueDate;
  const notes = clipText(task.notes, MAX_PLANNING_CHILD_NOTES);
  if (notes) result.notes = notes;
  return result;
}

function projectPlanningChild(project: ProjectRecord): CleanupPlanningChildContext {
  const result: CleanupPlanningChildContext = {
    id: project.id,
    title: project.title,
    targetType: "project",
  };
  if (project.status !== "active") result.status = project.status;
  const label = project.waitingOn?.map((value) => value.trim()).filter(Boolean).join(", ");
  if (label || project.waitingUntil) {
    result.externalWait = {
      ...(label ? { label } : {}),
      ...(project.waitingUntil ? { revisitDate: project.waitingUntil } : {}),
    };
  }
  if (project.scheduledDate) result.scheduledDate = project.scheduledDate;
  if (project.dueDate) result.dueDate = project.dueDate;
  const notes = clipText(project.notes, MAX_PLANNING_CHILD_NOTES);
  if (notes) result.notes = notes;
  return result;
}

export function omitEmptyPlanningContext(
  context: CleanupPlanningContext,
): CleanupPlanningContext | undefined {
  return context.currentNextAction
    || context.openChildren?.length
    || context.waitingChildren?.length
    || context.doneChildren?.length
    || context.existingAcceptanceCriteria?.length
    ? context
    : undefined;
}

function taskPlanningContext(
  graph: Graph,
  task: TaskRecord,
  nextAction: TaskRecord | null,
): CleanupPlanningContext | undefined {
  const children = graph.childrenByParent.get(task.id) ?? [];
  const waitingChildren = children
    .filter((child) => child.status !== "done" && child.status !== "cancelled" && (child.externalWait !== null || child.blocked))
    .slice(0, MAX_PLANNING_WAITING_CHILDREN)
    .map(taskPlanningChild);
  const openChildren = children
    .filter((child) => child.status !== "done" && child.status !== "cancelled" && child.externalWait === null && !child.blocked)
    .slice(0, MAX_PLANNING_OPEN_CHILDREN)
    .map(taskPlanningChild);
  const doneChildren = children
    .filter((child) => child.status === "done")
    .slice(0, MAX_PLANNING_DONE_CHILDREN)
    .map(taskPlanningChild);
  return omitEmptyPlanningContext({
    ...(nextAction && nextAction.id !== task.id
      ? {
          currentNextAction: {
            id: nextAction.id,
            title: nextAction.title,
            ...(nextAction.status !== "actionable" ? { status: nextAction.status } : {}),
          },
        }
      : {}),
    ...(openChildren.length > 0 ? { openChildren } : {}),
    ...(waitingChildren.length > 0 ? { waitingChildren } : {}),
    ...(doneChildren.length > 0 ? { doneChildren } : {}),
  });
}

function projectPlanningContext(graph: Graph, project: ProjectRecord): CleanupPlanningContext | undefined {
  const rootTasks = graph.rootsByProject.get(project.id) ?? [];
  const childProjects = [...graph.projectsById.values()].filter((child) => child.parentId === project.id);
  const openChildren = [
    ...rootTasks
      .filter((task) => task.status !== "done" && task.status !== "cancelled" && task.externalWait === null && !task.blocked)
      .map(taskPlanningChild),
    ...childProjects
      .filter((child) => (child.status === "active" || child.status === "backlog") && !child.waitingOn?.length && !child.waitingUntil)
      .map(projectPlanningChild),
  ].slice(0, MAX_PLANNING_OPEN_CHILDREN);
  const waitingChildren = [
    ...rootTasks
      .filter((task) => task.status !== "done" && task.status !== "cancelled" && (task.externalWait !== null || task.blocked))
      .map(taskPlanningChild),
    ...childProjects
      .filter((child) => (child.waitingOn?.length ?? 0) > 0 || child.waitingUntil !== null)
      .map(projectPlanningChild),
  ].slice(0, MAX_PLANNING_WAITING_CHILDREN);
  const doneChildren = [
    ...rootTasks.filter((task) => task.status === "done").map(taskPlanningChild),
    ...childProjects.filter((child) => child.status === "completed").map(projectPlanningChild),
  ].slice(0, MAX_PLANNING_DONE_CHILDREN);
  const existingAcceptanceCriteria = project.acceptanceCriteria
    .map((criterion) => criterion.text.trim())
    .filter(Boolean);
  return omitEmptyPlanningContext({
    ...(project.nextAction
      ? {
          currentNextAction: {
            id: project.nextAction.id,
            title: project.nextAction.title,
            ...(project.nextAction.status !== "actionable" ? { status: project.nextAction.status } : {}),
          },
        }
      : {}),
    ...(openChildren.length > 0 ? { openChildren } : {}),
    ...(waitingChildren.length > 0 ? { waitingChildren } : {}),
    ...(doneChildren.length > 0 ? { doneChildren } : {}),
    ...(existingAcceptanceCriteria.length > 0 ? { existingAcceptanceCriteria } : {}),
  });
}

export function taskContext(graph: Graph, task: TaskRecord): CleanupItemContext {
  const project = task.projectId !== null ? graph.projectsById.get(task.projectId) : undefined;
  const parent = task.parentTaskId !== null ? graph.tasksById.get(task.parentTaskId) : undefined;
  const siblings = (task.parentTaskId !== null
    ? graph.childrenByParent.get(task.parentTaskId)
    : graph.rootsByProject.get(task.projectId)) ?? [];
  const children = taskChildren(graph, task);
  const computedProject = project ? graph.projectWithComputed(project.id) : null;
  const planningContext = taskPlanningContext(graph, task, computedProject?.nextAction ?? null);
  return {
    targetType: "task",
    targetId: task.id,
    targetRevision: task.revision,
    item: {
      title: task.title,
      notes: clipNotes(task.notes),
      status: task.status,
      kind: task.kind,
    },
    hierarchy: {
      projectTitle: project?.title ?? null,
      parentTitle: parent?.title ?? null,
      childTitles: titles(children),
      // The root inbox has no meaningful sibling relation.
      siblingTitles: task.projectId === null && task.parentTaskId === null
        ? []
        : titles(siblings.filter((sibling) =>
            sibling.id !== task.id && sibling.status !== "done" && sibling.status !== "cancelled")),
    },
    ...(planningContext ? { planningContext } : {}),
    mechanicalFacts: {
      hasOwner: task.effectiveOwnerId !== null,
      hasDueDate: task.dueDate !== null,
      hasScheduledDate: task.scheduledDate !== null,
      hasExternalWait: task.externalWait !== null,
      hasRevisitDate: task.externalWait?.revisitDate != null,
      isBlocked: task.blocked,
      isExecutable: task.executable,
      graphNextActionTitle: computedProject?.nextAction?.title ?? null,
      stuckReason: computedProject?.stuckReason ?? null,
      childCount: children.length,
      notesLength: task.notes.trim().length,
      reviewedAt: task.reviewedAt,
    },
  };
}

export function projectContext(graph: Graph, projectId: number): CleanupItemContext | null {
  const project = graph.projectWithComputed(projectId);
  if (!project) return null;
  const parent = project.parentId !== null ? graph.projectsById.get(project.parentId) : undefined;
  const children = projectChildren(graph, project);
  const planningContext = projectPlanningContext(graph, project);
  const siblings = [...graph.projectsById.values()].filter(
    (other) => other.id !== project.id && other.parentId === project.parentId && openProject(other),
  );
  return {
    targetType: "project",
    targetId: project.id,
    targetRevision: project.revision,
    item: {
      title: project.title,
      notes: clipNotes(project.notes),
      status: project.status,
      acceptanceCriteria: project.acceptanceCriteria.map((criterion) => criterion.text),
    },
    hierarchy: {
      projectTitle: parent?.title ?? null,
      parentTitle: null,
      childTitles: titles(children),
      // Top-level projects are independent; only nested stories have siblings.
      siblingTitles: project.parentId === null ? [] : titles(siblings),
    },
    ...(planningContext ? { planningContext } : {}),
    mechanicalFacts: {
      hasOwner: project.ownerMemberId !== null,
      hasDueDate: project.dueDate !== null,
      hasScheduledDate: project.scheduledDate !== null,
      hasExternalWait: (project.waitingOn?.length ?? 0) > 0,
      hasRevisitDate: (project.waitingUntil ?? null) !== null,
      isBlocked: false,
      isExecutable: (project.nextAction ?? null) !== null,
      graphNextActionTitle: project.nextAction?.title ?? null,
      stuckReason: project.stuckReason ?? null,
      childCount: children.length,
      notesLength: project.notes.trim().length,
      reviewedAt: project.reviewedAt,
    },
  };
}

/**
 * Picks the highest-scoring candidates under the per-cluster cap and, when
 * both shapes are available, swaps in one of the missing shape. A swap
 * replaces the lowest-ranked pick whose removal keeps the replacement's
 * cluster within `MAX_PER_CLUSTER`.
 */
export function selectCleanupBatch<T extends Pick<CleanupCandidate, "targetType" | "cluster" | "score">>(
  candidates: readonly T[],
  limit: number,
): T[] {
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const picked: T[] = [];
  const perCluster = new Map<string, number>();
  for (const candidate of ranked) {
    if (picked.length >= limit) break;
    const count = perCluster.get(candidate.cluster) ?? 0;
    if (count >= MAX_PER_CLUSTER) continue;
    perCluster.set(candidate.cluster, count + 1);
    picked.push(candidate);
  }
  for (const type of ["project", "task"] as const) {
    if (picked.length < 2 || picked.some((candidate) => candidate.targetType === type)) continue;
    swap: for (const replacement of ranked) {
      if (replacement.targetType !== type) continue;
      for (let index = picked.length - 1; index >= 0; index -= 1) {
        const victim = picked[index]!;
        const count = (perCluster.get(replacement.cluster) ?? 0)
          - (victim.cluster === replacement.cluster ? 1 : 0);
        if (count >= MAX_PER_CLUSTER) continue;
        perCluster.set(victim.cluster, (perCluster.get(victim.cluster) ?? 1) - 1);
        perCluster.set(replacement.cluster, (perCluster.get(replacement.cluster) ?? 0) + 1);
        picked[index] = replacement;
        break swap;
      }
    }
  }
  return picked;
}

/**
 * Chooses a small mixed batch of open work items worth a semantic look.
 * This is selection, not diagnosis: staleness, notes, children and vague
 * titles only nudge weighted randomness, and a per-cluster cap keeps one
 * project from dominating the round.
 */
export function sampleCleanupCandidates(
  graph: Graph,
  options: CleanupSampleOptions,
): CleanupItemContext[] {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const limit = options.limit ?? CLEANUP_ROUND_SAMPLE_LIMIT;
  const candidates: CleanupCandidate[] = [];

  for (const task of graph.allActions()) {
    if (task.scope !== options.scope) continue;
    if (task.status !== "captured" && task.status !== "actionable" && task.status !== "someday") continue;
    if (task.projectId !== null && !openProject(graph.projectsById.get(task.projectId))) continue;
    if (recentlyReviewed(task.reviewedAt, now)) continue;
    if (options.excludedKeys.has(`task:${task.id}`)) continue;
    candidates.push({
      targetType: "task",
      targetId: task.id,
      cluster: task.projectId !== null
        ? `project:${task.projectId}`
        : task.parentTaskId !== null ? `parent:${task.parentTaskId}` : `task:${task.id}`,
      score: score(task, taskChildren(graph, task).length, now, random),
    });
  }
  for (const project of graph.projectsById.values()) {
    if (project.scope !== options.scope || !openProject(project)) continue;
    if (recentlyReviewed(project.reviewedAt, now)) continue;
    if (options.excludedKeys.has(`project:${project.id}`)) continue;
    candidates.push({
      targetType: "project",
      targetId: project.id,
      cluster: `project:${project.id}`,
      score: score(project, projectChildren(graph, project).length, now, random),
    });
  }

  const picked = selectCleanupBatch(candidates, limit);

  return picked
    .map((candidate) => candidate.targetType === "task"
      ? taskContext(graph, graph.tasksById.get(candidate.targetId)!)
      : projectContext(graph, candidate.targetId))
    .filter((context): context is CleanupItemContext => context !== null);
}
