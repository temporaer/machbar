import {
  projectStatusLabels,
  taskStatusLabels,
  type ActivityEvent,
  type ActivityEventMetadata,
  type ProjectStatus,
  type TaskStatus,
} from "@machbar/shared";

const fieldLabels: Record<string, string> = {
  title: "Titel",
  notes: "Notizen",
  ownerMemberId: "Zuständigkeit",
  ownerInheritanceMode: "Zuständigkeit",
  dueDate: "Fälligkeit",
  scheduledDate: "Planung",
  waitingFor: "Wartegrund",
  priority: "Priorität",
  size: "Größe",
  recurrenceRule: "Wiederholung",
  reminderAt: "Erinnerung",
  notesAppended: "Notizen",
  taskSequence: "Aufgabenfolge",
};

function entityNoun(event: ActivityEvent): "Aufgabe" | "Projekt" {
  return event.entity.type === "task" ? "Aufgabe" : "Projekt";
}

function statusLabel(status: TaskStatus | ProjectStatus | undefined): string | null {
  if (!status) return null;
  if (status in taskStatusLabels) return taskStatusLabels[status as TaskStatus];
  return projectStatusLabels[status as ProjectStatus];
}

function changedFields(metadata: ActivityEventMetadata): string {
  const labels = [...new Set((metadata.changedFields ?? []).map((field) => fieldLabels[field] ?? field))];
  if (labels.length === 0) return "";
  if (labels.length === 1) return `: ${labels[0]}`;
  return `: ${labels.slice(0, -1).join(", ")} und ${labels.at(-1)}`;
}

export function formatActivityDescription(event: ActivityEvent): string {
  const noun = entityNoun(event);
  const previous = statusLabel(event.metadata.previousStatus);
  const next = statusLabel(event.metadata.nextStatus);
  const count = event.metadata.affectedCount;

  switch (event.kind) {
    case "task_created":
      return event.metadata.relatedTaskTitles?.length
        ? `hat eine Folgeaufgabe zu „${event.metadata.relatedTaskTitles[0]}“ erstellt`
        : "hat die Aufgabe erstellt";
    case "project_created":
      return "hat das Projekt erstellt";
    case "task_updated":
    case "project_updated":
      if (event.metadata.changedFields?.includes("taskSequence") && count) {
        return `hat eine Aufgabenfolge mit ${count} Schritten erstellt`;
      }
      return `hat ${noun === "Aufgabe" ? "die" : "das"} ${noun} aktualisiert${changedFields(event.metadata)}`;
    case "task_deleted": {
      const children = count && count > 1 ? count - 1 : 0;
      return children
        ? `hat die Aufgabe und ${children} ${children === 1 ? "Teilaufgabe" : "Teilaufgaben"} gelöscht`
        : "hat die Aufgabe gelöscht";
    }
    case "project_deleted":
      return "hat das Projekt gelöscht";
    case "task_status_changed":
    case "project_status_changed":
      return `${previous && next
        ? `hat den Status von „${previous}“ auf „${next}“ geändert`
        : next
          ? `hat den Status auf „${next}“ geändert`
          : "hat den Status geändert"}${count && count > 1 ? ` (${count} Aufgaben)` : ""}`;
    case "task_descendants_status_changed": {
      const status = next ?? "einen neuen Status";
      const affected = count ?? 0;
      const subject = affected === 1 ? "eine Teilaufgabe" : `${affected} Teilaufgaben`;
      return `hat ${subject} auf „${status}“ gesetzt`;
    }
    case "task_moved": {
      const task = event.metadata.relatedTaskTitles?.at(-1);
      const project = event.metadata.relatedProjectTitles?.at(-1);
      const target = task ?? project;
      return target ? `hat die Aufgabe nach „${target}“ verschoben` : "hat die Aufgabe verschoben";
    }
    case "task_dependencies_changed":
      return event.metadata.relatedTaskTitles?.length
        ? `hat Abhängigkeiten geändert: ${event.metadata.relatedTaskTitles.join(", ")}`
        : "hat Abhängigkeiten geändert";
    case "task_tags_changed":
      return "hat die Tags der Aufgabe geändert";
    case "project_tags_changed":
      return "hat die Tags des Projekts geändert";
    case "project_acceptance_criterion_added":
      return "hat ein Ergebniskriterium hinzugefügt";
    case "project_acceptance_criterion_updated":
      return "hat ein Ergebniskriterium geändert";
    case "project_acceptance_criterion_checked":
      return event.metadata.checked === false
        ? "hat ein Ergebniskriterium wieder geöffnet"
        : "hat ein Ergebniskriterium abgehakt";
    case "project_acceptance_criterion_removed":
      return "hat ein Ergebniskriterium entfernt";
  }
}

export function formatActivityExactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unbekannter Zeitpunkt";
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatActivityRelativeTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return "unbekannt";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1_000);
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 45) return "gerade eben";

  const formatter = new Intl.RelativeTimeFormat("de-DE", { numeric: "always" });
  if (absoluteSeconds < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absoluteSeconds < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  return formatter.format(Math.round(seconds / 86_400), "day");
}

export function activityDateGroup(value: string, now = new Date()): { key: string; label: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { key: "unknown", label: "Unbekannt" };

  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const difference = Math.round((today.getTime() - eventDay.getTime()) / 86_400_000);
  if (difference === 0) return { key, label: "Heute" };
  if (difference === 1) return { key, label: "Gestern" };
  return {
    key,
    label: new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).format(eventDay),
  };
}
