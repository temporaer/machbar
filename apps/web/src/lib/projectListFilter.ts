import type { ProjectWithActions } from "./api";
import type { Locale } from "../i18n/catalog";
import { isFutureCalendarDate } from "./relativeDate";

/** The three visibility scopes the Projekte tab's compact chips switch
 * between. Work and household items are never mixed: "work" shows only the
 * viewer's own work-scope projects, "mine"/"all" only ever show
 * household-scope ones (a household member's own work projects are excluded
 * from the household views too). */
export type ProjectVisibilityScope = "mine" | "all" | "work";

export interface ProjectListFilterOptions {
  /** Free-text query, matched against title, notes, and completion criteria. */
  query: string;
  scope: ProjectVisibilityScope;
  /** The currently selected identity, or `null` when no member is selected yet. */
  currentMemberId: number | null;
  locale?: Locale;
  /** Local clock injected by tests; defaults to the current browser time. */
  now?: Date;
}

export type ProjectListClassification =
  | "active-actionable"
  | "active-review"
  | "active-stuck"
  | "active-deferred"
  | "active-waiting"
  | "backlog"
  | "completed"
  | "archived";

/** Strips diacritics and lower-cases so "Cafe" matches "Café" and vice versa. */
function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function matchesQuery(project: ProjectWithActions, foldedQuery: string): boolean {
  if (!foldedQuery) return true;
  if (foldForSearch(project.title).includes(foldedQuery)) return true;
  if (foldForSearch(project.notes).includes(foldedQuery)) return true;
  if ((project.waitingOn ?? []).some((value) => foldForSearch(value).includes(foldedQuery))) {
    return true;
  }
  return (project.acceptanceCriteria ?? []).some((c) => foldForSearch(c.text).includes(foldedQuery));
}

/**
 * Default visibility is "mine & open": the selected member's own stories plus
 * every unassigned one, so nothing anybody could still pick up gets hidden.
 * With no identity selected there is no "mine" to speak of, so the default
 * scope sensibly collapses to unassigned-only rather than showing nothing —
 * or everything.
 */
function matchesScope(project: ProjectWithActions, scope: ProjectVisibilityScope, currentMemberId: number | null): boolean {
  if (scope === "work") return project.scope === "work";
  if (project.scope === "work") return false;
  if (scope === "all") return true;
  if (currentMemberId === null) return project.ownerMemberId === null;
  return project.ownerMemberId === null || project.ownerMemberId === currentMemberId;
}

export function countScopeHiddenMatches(
  projects: ProjectWithActions[],
  query: string,
  currentMemberId: number | null,
): number {
  const foldedQuery = foldForSearch(query.trim());
  if (!foldedQuery) return 0;
  return projects.filter(
    (project) =>
      matchesQuery(project, foldedQuery) &&
      !matchesScope(project, "mine", currentMemberId),
  ).length;
}

/**
 * Classifies a project for the list without changing its persisted workflow
 * status. Active waiting is the narrow active state with neither a next
 * action nor a stuck reason; a next action scheduled for a future calendar
 * date is also quiet because it is not useful foreground work yet. Any
 * active stuck reason takes precedence.
 *
 * `completion_review` is deliberately not "stuck": an active project with
 * zero remaining open tasks is healthy and ready for a completion decision,
 * not blocked. It gets its own `active-review` classification so the UI can
 * present it distinctly from a genuine `active-stuck` blocker.
 */
export function classifyProjectListItem(
  project: ProjectWithActions,
  now = new Date(),
): ProjectListClassification {
  if (project.status === "active") {
    if (project.stuckReason === "completion_review") return "active-review";
    if (project.stuckReason != null) return "active-stuck";
    if (
      project.nextAction?.scheduledDate &&
      isFutureCalendarDate(project.nextAction.scheduledDate, now)
    ) {
      return "active-deferred";
    }
    if (project.nextAction == null) {
      return project.deferredNextAction ? "active-deferred" : "active-waiting";
    }
    return "active-actionable";
  }
  return project.status;
}

const projectListClassificationOrder: Record<ProjectListClassification, number> = {
  "active-actionable": 0,
  "active-review": 1,
  "active-stuck": 2,
  "active-deferred": 3,
  "active-waiting": 3,
  backlog: 4,
  completed: 5,
  archived: 6,
};

function projectListSortOrder(
  project: ProjectWithActions,
  now: Date,
): number {
  const classification = classifyProjectListItem(project, now);
  return projectListClassificationOrder[classification];
}

/** The date and fallback band used to order quiet active projects. */
function activeQuietSortKey(
  project: ProjectWithActions,
  now: Date,
): { band: 0 | 1 | 2; date: number | null } {
  const classification = classifyProjectListItem(project, now);
  const date = classification === "active-deferred"
    ? project.nextAction?.scheduledDate ?? project.deferredNextAction?.revisitAt
    : classification === "active-waiting"
      ? project.waitingUntil
      : null;
  const timestamp = date ? Date.parse(date) : Number.NaN;
  if (Number.isFinite(timestamp)) return { band: 1, date: timestamp };
  // Keep a deferred next-action candidate ahead of external waits when neither
  // has a usable date; undated waits follow the dated quiet work.
  return classification === "active-deferred"
    ? { band: 0, date: null }
    : { band: 2, date: null };
}

/**
 * A story is "terminal" once it has left the active workflow for good:
 * completed or archived. The Projekte tab groups these two statuses into
 * one folded section below the primary (active/backlog) list, so this is
 * the single place that decides which statuses count as terminal.
 */
export function isTerminalProjectStatus(project: ProjectWithActions): boolean {
  return project.status === "completed" || project.status === "archived";
}

/**
 * Filters (search text + visibility scope), then deterministically sorts, the
 * Projekte tab's story list. Filtering always runs before sorting so a
 * bucket never contains a story the current search/scope would hide.
 *
 * Sort buckets, in order: active & actionable, active & ready-to-complete
 * (`completion_review`), active & stuck, quiet active projects
 * (future-scheduled next actions and external waits), backlog, completed,
 * archived. Quiet projects with dates are interleaved chronologically:
 * scheduled date for next actions, revisit date for external waits. Undated
 * next-action candidates lead that date band; undated external waits follow
 * it. Ties break on classification, backend-assigned `position`, locale-aware
 * title, then id, so the order stays stable and reproducible across reloads.
 */
export function filterAndSortProjects(
  projects: ProjectWithActions[],
  {
    query,
    scope,
    currentMemberId,
    locale = "de",
    now = new Date(),
  }: ProjectListFilterOptions,
): ProjectWithActions[] {
  const foldedQuery = foldForSearch(query.trim());
  const filtered = projects.filter(
    (p) =>
      matchesScope(p, scope, currentMemberId) &&
      matchesQuery(p, foldedQuery),
  );
  return filtered.sort((a, b) => {
    const bucketDiff =
      projectListSortOrder(a, now) - projectListSortOrder(b, now);
    if (bucketDiff !== 0) return bucketDiff;
    const aClass = classifyProjectListItem(a, now);
    const bClass = classifyProjectListItem(b, now);
    if (
      (aClass === "active-deferred" || aClass === "active-waiting") &&
      (bClass === "active-deferred" || bClass === "active-waiting")
    ) {
      const aKey = activeQuietSortKey(a, now);
      const bKey = activeQuietSortKey(b, now);
      if (aKey.band !== bKey.band) return aKey.band - bKey.band;
      if (aKey.band === 1 && aKey.date !== bKey.date) {
        return (aKey.date ?? 0) - (bKey.date ?? 0);
      }
      // Keep the two kinds visually grouped when their dates are identical
      // or both are missing, with each kind still recognizable by its color.
      if (aClass !== bClass) {
        return projectListClassificationOrder[aClass] - projectListClassificationOrder[bClass];
      }
    }
    if (a.position !== b.position) return a.position - b.position;
    const titleDiff = a.title.localeCompare(b.title, locale);
    if (titleDiff !== 0) return titleDiff;
    return a.id - b.id;
  });
}
