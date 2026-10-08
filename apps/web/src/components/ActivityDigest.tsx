import type {
  ActivityDigest,
  ActivityDigestEntry,
  ActivityDigestCategory,
} from "@machbar/shared";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useOptionalIdentity } from "../lib/identity";
import { useLocale } from "../lib/locale";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useAsync } from "../lib/useAsync";

function pathFor(entry: ActivityDigestEntry): string | null {
  const primary = entry.primary;
  if (!primary || primary.id === null) return null;
  return primary.type === "task"
    ? `/tasks/${primary.id}`
    : `/projects/${primary.id}`;
}

function entryText(
  entry: ActivityDigestEntry,
  strings: ReturnType<typeof useLocale>["strings"],
): string {
  const actor =
    entry.actor?.name ?? strings.activityText.unknownActor;
  const title = String(entry.params.title ?? entry.primary?.title ?? "");
  const formatDate = (value: string): string | null => {
    const isCalendarDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const parsed = isCalendarDate
      ? new Date(`${value}T00:00:00Z`)
      : new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, isCalendarDate
      ? { dateStyle: "long", timeZone: "UTC" }
      : { dateStyle: "long", timeStyle: "short" }).format(parsed);
  };
  switch (entry.kind) {
    case "task_assigned":
      return strings.activityDigestTaskAssigned(actor, title);
    case "task_unassigned":
      return strings.activityDigestTaskUnassigned(title);
    case "task_completed":
      return strings.activityDigestTaskCompleted(actor, title);
    case "project_completed":
      if (typeof entry.params.completionCount === "number") {
        return strings.activityDigestProjectCompletedWithProgress(
          actor,
          title,
          entry.params.completionCount,
        );
      }
      return strings.activityDigestProjectCompleted(actor, title);
    case "project_reopened":
      return strings.activityDigestProjectReopened(title);
    case "project_activated":
      return strings.activityDigestProjectActivated(title);
    case "project_progress":
      if (Array.isArray(entry.params.actorCounts)) {
        const breakdown = entry.params.actorCounts
          .map((value) => {
            if (
              typeof value !== "object" ||
              value === null ||
              !("count" in value) ||
              !("actor" in value) ||
              typeof value.count !== "number"
            ) {
              return null;
            }
            const actorValue = value.actor;
            const name =
              typeof actorValue === "object" &&
              actorValue !== null &&
              "name" in actorValue &&
              typeof actorValue.name === "string"
                ? actorValue.name
                : strings.activityText.unknownActor;
            return `${value.count} ${name}`;
          })
          .filter((value): value is string => value !== null)
          .join(" · ");
        if (breakdown) {
          return strings.activityDigestProjectProgressDetailed(
            Number(entry.params.count ?? 0),
            entry.project?.title ?? title,
            breakdown,
            Array.isArray(entry.params.titles)
              ? entry.params.titles.slice(0, 2).join(" · ")
              : title,
          );
        }
      }
      return strings.activityDigestProjectProgress(
        Number(entry.params.count ?? 0),
        entry.project?.title ?? title,
      );
    case "project_assignment":
      return strings.activityDigestProjectAssigned(
        Number(entry.params.count ?? 0),
        entry.project?.title ?? title,
      );
    case "plan_changed":
      if (typeof entry.params.date === "string") {
        const date = formatDate(entry.params.date);
        if (!date) {
          if (entry.params.dateType === "availability") {
            return strings.activityDigestWaitResolved(title);
          }
        } else if (entry.params.dateType === "deadline") {
          return strings.activityDigestDeadlineChanged(
            actor,
            title,
            date,
            String(entry.params.direction ?? "later"),
          );
        } else if (entry.params.dateType === "scheduled") {
          return strings.activityDigestScheduledChanged(title, date);
        } else if (entry.params.dateType === "availability") {
          return strings.activityDigestAvailabilityChanged(title, date);
        }
      }
      if (
        entry.params.dateType === "deadline" &&
        entry.params.direction === "removed"
      ) {
        return strings.activityDigestDeadlineRemoved(actor, title);
      }
      if (entry.params.dateType === "availability") {
        return strings.activityDigestWaitResolved(title);
      }
      return strings.activityDigestPlanChanged(actor, title);
    case "wait_started":
      return strings.activityDigestWaitStarted(title);
    case "wait_resolved":
      return strings.activityDigestWaitResolved(title);
    case "new_work":
      return strings.activityDigestNewWork(title);
    case "task_executable":
      return strings.activityDigestWaitResolved(title);
  }
  return title;
}

const categoryOrder: ActivityDigestCategory[] = [
  "personal",
  "milestone",
  "progress",
  "plan",
  "new_work",
];

function categoryLabel(
  category: ActivityDigestCategory,
  strings: ReturnType<typeof useLocale>["strings"],
): string {
  switch (category) {
    case "personal":
      return strings.activityDigestCategoryPersonal;
    case "milestone":
      return strings.activityDigestCategoryMilestone;
    case "progress":
      return strings.activityDigestCategoryProgress;
    case "plan":
      return strings.activityDigestCategoryPlan;
    case "new_work":
      return strings.activityDigestCategoryNewWork;
  }
  return category;
}

export function ActivityDigest() {
  const { strings } = useLocale();
  const { currentMemberId } = useOptionalIdentity();
  const [expanded, setExpanded] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const memberKey = currentMemberId ?? "none";
  const { data, error, refreshError, reload } = useAsync<ActivityDigest | null>(
    () =>
      currentMemberId === null
        ? Promise.resolve(null)
        : typeof api.getActivityDigest === "function"
          ? api.getActivityDigest(
              currentMemberId,
              Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            )
          : Promise.resolve(null),
    [memberKey],
  );

  useEffect(() => {
    setExpanded(false);
    setAckError(null);
  }, [memberKey]);

  const entries = data?.entries ?? [];
  const visibleEntries = expanded ? entries : entries.slice(0, 5);
  const grouped = useMemo(() => {
    const map = new Map<ActivityDigestCategory, ActivityDigestEntry[]>();
    for (const category of categoryOrder) map.set(category, []);
    for (const entry of visibleEntries) {
      map.get(entry.category)?.push(entry);
    }
    return [...map.entries()].filter(([, values]) => values.length > 0);
  }, [visibleEntries]);

  if (entries.length === 0) {
    const emptyStateError = data === null ? error : refreshError;
    if (emptyStateError !== null) {
      return (
        <div className="activity-digest-error">
          <p className="form-error" role="alert">
            {emptyStateError}
          </p>
          <button type="button" className="btn btn-sm btn-ghost" onClick={reload}>
            {strings.activityDigestRetry}
          </button>
        </div>
      );
    }
    return null;
  }

  const acknowledge = async () => {
    if (!data || acknowledging) return;
    setAcknowledging(true);
    setAckError(null);
    try {
      if (typeof api.acknowledgeActivityDigest !== "function") return;
      await api.acknowledgeActivityDigest(data.throughEventId, currentMemberId);
      reload();
    } catch (cause) {
      setAckError(localizedErrorMessage(cause, strings));
    } finally {
      setAcknowledging(false);
    }
  };

  return (
    <section className="activity-digest" aria-labelledby="activity-digest-title">
      <div className="activity-digest-header">
        <h2 id="activity-digest-title">{strings.activityDigestTitle}</h2>
        {entries.length > 5 ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? strings.activityDigestShowLess
              : strings.activityDigestShowMore}
          </button>
        ) : null}
      </div>
      <div className="activity-digest-groups">
        {grouped.map(([category, categoryEntries]) => (
          <section
            className="activity-digest-group"
            key={category}
            aria-labelledby={`activity-digest-${category}`}
          >
            <h3 id={`activity-digest-${category}`}>
              {categoryLabel(category, strings)}
            </h3>
            <ul className="activity-digest-list">
              {categoryEntries.map((entry) => {
                const path = pathFor(entry);
                return (
                  <li className="activity-digest-entry" key={entry.key}>
                    {path ? (
                      <Link to={path}>{entryText(entry, strings)}</Link>
                    ) : (
                      <span>{entryText(entry, strings)}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {refreshError ? (
        <p className="form-error" role="alert">
          {refreshError}
        </p>
      ) : null}
      {refreshError ? (
        <button type="button" className="btn btn-sm btn-ghost" onClick={reload}>
          {strings.activityDigestRetry}
        </button>
      ) : null}
      {ackError ? (
        <p className="form-error" role="alert">
          {strings.activityDigestAcknowledgeError}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        onClick={acknowledge}
        disabled={acknowledging}
      >
        {strings.activityDigestAcknowledge}
      </button>
    </section>
  );
}
