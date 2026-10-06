import type {
  CleanupItemContext,
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

export interface CleanupSampleOptions {
  scope: WorkItemScope;
  /** `${targetType}:${targetId}` keys already in an active round. */
  excludedKeys: ReadonlySet<string>;
  now?: Date;
  random?: () => number;
  limit?: number;
}

interface Candidate {
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

export function taskContext(graph: Graph, task: TaskRecord): CleanupItemContext {
  const project = task.projectId !== null ? graph.projectsById.get(task.projectId) : undefined;
  const parent = task.parentTaskId !== null ? graph.tasksById.get(task.parentTaskId) : undefined;
  const siblings = (task.parentTaskId !== null
    ? graph.childrenByParent.get(task.parentTaskId)
    : graph.rootsByProject.get(task.projectId)) ?? [];
  const children = taskChildren(graph, task);
  const computedProject = project ? graph.projectWithComputed(project.id) : null;
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
  const candidates: Candidate[] = [];

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

  candidates.sort((a, b) => b.score - a.score);
  const picked: Candidate[] = [];
  const perCluster = new Map<string, number>();
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    const count = perCluster.get(candidate.cluster) ?? 0;
    if (count >= MAX_PER_CLUSTER) continue;
    perCluster.set(candidate.cluster, count + 1);
    picked.push(candidate);
  }
  // Keep the batch mixed when both shapes are available.
  for (const type of ["project", "task"] as const) {
    if (picked.length < 2 || picked.some((candidate) => candidate.targetType === type)) continue;
    const replacement = candidates.find((candidate) => candidate.targetType === type);
    if (replacement) picked[picked.length - 1] = replacement;
  }

  return picked
    .map((candidate) => candidate.targetType === "task"
      ? taskContext(graph, graph.tasksById.get(candidate.targetId)!)
      : projectContext(graph, candidate.targetId))
    .filter((context): context is CleanupItemContext => context !== null);
}
