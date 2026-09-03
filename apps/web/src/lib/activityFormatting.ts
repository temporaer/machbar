import type {
  ActivityEvent,
  ActivityEventMetadata,
  ProjectStatus,
  TaskStatus,
} from "@machbar/shared";
import {
  getCatalog,
  type Locale,
  type TranslationCatalog,
} from "../i18n/catalog";
import { localeTag } from "./format";

function statusLabel(
  status: TaskStatus | ProjectStatus | undefined,
  strings: TranslationCatalog,
): string | null {
  if (!status) return null;
  if (status in strings.taskStatusLabels) {
    return strings.taskStatusLabels[status as TaskStatus];
  }
  return strings.projectStatusLabels[status as ProjectStatus];
}

function changedFields(
  metadata: ActivityEventMetadata,
  strings: TranslationCatalog,
): string {
  const fieldLabels = strings.activityText.fieldLabels as Readonly<
    Record<string, string>
  >;
  const labels = [
    ...new Set(
      (metadata.changedFields ?? []).map(
        (field) => fieldLabels[field] ?? field,
      ),
    ),
  ];
  if (labels.length === 0) return "";
  if (labels.length === 1) {
    return strings.activityText.changedFieldsOne(labels[0]!);
  }
  return strings.activityText.changedFieldsMany(
    labels.slice(0, -1),
    labels.at(-1)!,
  );
}

/**
 * Activity payloads stay language-neutral: descriptions are assembled from
 * event kinds and metadata here instead of displaying API-provided prose.
 */
export function formatActivityDescription(
  event: ActivityEvent,
  locale: Locale = "de",
): string {
  const strings = getCatalog(locale);
  const previous = statusLabel(event.metadata.previousStatus, strings);
  const next = statusLabel(event.metadata.nextStatus, strings);
  const count = event.metadata.affectedCount;

  switch (event.kind) {
    case "task_created":
      return event.metadata.relatedTaskTitles?.length
        ? strings.activityText.successorCreated(
            event.metadata.relatedTaskTitles[0]!,
          )
        : strings.activityText.taskCreated;
    case "project_created":
      return strings.activityText.projectCreated;
    case "task_updated":
    case "project_updated":
      if (event.metadata.changedFields?.includes("taskSequence") && count) {
        return strings.activityText.sequenceCreated(count);
      }
      return strings.activityText.entityUpdated(
        event.entity.type,
        changedFields(event.metadata, strings),
      );
    case "task_deleted": {
      const children = count && count > 1 ? count - 1 : 0;
      return children
        ? strings.activityText.taskAndChildrenDeleted(children)
        : strings.activityText.taskDeleted;
    }
    case "project_deleted":
      return strings.activityText.projectDeleted;
    case "task_status_changed":
    case "project_status_changed": {
      if (
        event.kind === "task_status_changed" &&
        event.metadata.recurrenceOccurrenceId
      ) {
        return strings.activityText.recurrenceCompleted(
          event.metadata.recurrenceResult === "miss",
          event.metadata.nextScheduledDate ?? "",
        );
      }
      const description =
        previous && next
          ? strings.activityText.statusFromTo(previous, next)
          : next
            ? strings.activityText.statusTo(next)
            : strings.activityText.statusChanged;
      return `${description}${
        count && count > 1 ? strings.activityText.affectedTasks(count) : ""
      }`;
    }
    case "task_descendants_status_changed":
      return strings.activityText.descendantsStatusChanged(
        count ?? 0,
        next ?? strings.activityText.newStatus,
      );
    case "task_moved": {
      const task = event.metadata.relatedTaskTitles?.at(-1);
      const project = event.metadata.relatedProjectTitles?.at(-1);
      const target = task ?? project;
      return target
        ? strings.activityText.taskMovedTo(target)
        : strings.activityText.taskMoved;
    }
    case "task_dependencies_changed":
      return event.metadata.relatedTaskTitles?.length
        ? strings.activityText.dependenciesChangedWith(
            event.metadata.relatedTaskTitles,
          )
        : strings.activityText.dependenciesChanged;
    case "task_external_wait_started":
    case "task_external_wait_updated":
    case "task_external_wait_resolved":
      return strings.activityText.entityUpdated(
        "task",
        changedFields(event.metadata, strings),
      );
    case "task_tags_changed":
      return strings.activityText.taskTagsChanged;
    case "project_tags_changed":
      return strings.activityText.projectTagsChanged;
    case "task_contexts_changed":
      return strings.activityText.taskContextsChanged;
    case "project_contexts_changed":
      return strings.activityText.projectContextsChanged;
    case "project_acceptance_criterion_added":
      return strings.activityText.criterionAdded;
    case "project_acceptance_criterion_updated":
      return strings.activityText.criterionUpdated;
    case "project_acceptance_criterion_checked":
      return event.metadata.checked === false
        ? strings.activityText.criterionReopened
        : strings.activityText.criterionChecked;
    case "project_acceptance_criterion_removed":
      return strings.activityText.criterionRemoved;
  }
}

export function formatActivityExactTime(
  value: string,
  locale: Locale = "de",
): string {
  const strings = getCatalog(locale);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return strings.unknownTime;
  return new Intl.DateTimeFormat(localeTag(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatActivityRelativeTime(
  value: string,
  now = new Date(),
  locale: Locale = "de",
): string {
  const strings = getCatalog(locale);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) {
    return strings.unknown.toLocaleLowerCase(localeTag(locale));
  }
  const seconds = Math.round((date.getTime() - now.getTime()) / 1_000);
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 45) return strings.justNow;

  const formatter = new Intl.RelativeTimeFormat(localeTag(locale), {
    numeric: "always",
  });
  if (absoluteSeconds < 3_600) {
    return formatter.format(Math.round(seconds / 60), "minute");
  }
  if (absoluteSeconds < 86_400) {
    return formatter.format(Math.round(seconds / 3_600), "hour");
  }
  return formatter.format(Math.round(seconds / 86_400), "day");
}

export function activityDateGroup(
  value: string,
  now = new Date(),
  locale: Locale = "de",
): { key: string; label: string } {
  const strings = getCatalog(locale);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { key: "unknown", label: strings.unknown };
  }

  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const difference = Math.round(
    (today.getTime() - eventDay.getTime()) / 86_400_000,
  );
  if (difference === 0) return { key, label: strings.today };
  if (difference === 1) return { key, label: strings.yesterday };
  return {
    key,
    label: new Intl.DateTimeFormat(localeTag(locale), {
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).format(eventDay),
  };
}
