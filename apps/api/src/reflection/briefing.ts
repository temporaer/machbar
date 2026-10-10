import type { ReflectionBriefing, ReflectionBriefingScope, ReflectionWorkItemFact, ActivityEventMetadata } from "@machbar/shared";
import { DEFAULT_HOUSEHOLD_TIMEZONE } from "@machbar/shared";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { Graph, type TaskRecord, type ProjectRecord } from "../domain/graph.js";
import { getEffectiveOwners } from "../repo/effectiveRepo.js";

export interface ReflectionBriefingOptions {
  subjectMemberId: number;
  days: 30 | 90 | 180;
  scope: ReflectionBriefingScope;
  now?: Date;
}

function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validTimezone(db: Db): string {
  const value = db.select({ value: schema.householdSettings.value })
    .from(schema.householdSettings).where(eq(schema.householdSettings.key, "timezone")).get()?.value
    ?? DEFAULT_HOUSEHOLD_TIMEZONE;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return value; }
  catch { return DEFAULT_HOUSEHOLD_TIMEZONE; }
}

function statusLabel(item: TaskRecord | ProjectRecord): string {
  return item.status;
}

function factForTask(task: TaskRecord, graph: Graph, names: Map<number, string>): ReflectionWorkItemFact {
  return {
    id: task.id, type: "task", title: task.title, status: statusLabel(task), scope: task.scope,
    notes: task.notes,
    href: `#/tasks/${task.id}`,
    owner: task.effectiveOwnerId === null ? null : { id: task.effectiveOwnerId, name: names.get(task.effectiveOwnerId) ?? `Mitglied ${task.effectiveOwnerId}` },
    areaTags: task.effectiveAreaTags.map((tag) => tag.name), dueDate: task.dueDate,
    scheduledDate: task.scheduledDate, revisitAt: task.revisitAt,
    notBeforeAt: task.notBeforeAt, notBeforeDate: task.notBeforeDate,
    project: task.projectId === null ? null : (() => { const project = graph.projectsById.get(task.projectId!); return project ? { id: project.id, title: project.title } : null; })(),
    waitingFor: task.externalWait?.waitingFor ?? null,
    dependencies: task.dependencies.filter((dependency) => !dependency.resolved).map((dependency) => ({ id: dependency.dependsOnTaskId, title: dependency.title ?? `Aufgabe ${dependency.dependsOnTaskId}`, resolved: false })),
  };
}

function factForProject(project: ProjectRecord, graph: Graph, names: Map<number, string>): ReflectionWorkItemFact {
  const parent = project.parentId === null ? undefined : graph.projectsById.get(project.parentId);
  return {
    id: project.id, type: "project", title: project.title, status: project.status, scope: project.scope,
    notes: project.notes,
    href: `#/projects/${project.id}`,
    owner: project.ownerMemberId === null ? null : { id: project.ownerMemberId, name: names.get(project.ownerMemberId) ?? `Mitglied ${project.ownerMemberId}` },
    areaTags: project.effectiveTags.filter((tag) => tag.kind === "area").map((tag) => tag.name),
    dueDate: project.dueDate, scheduledDate: project.scheduledDate, revisitAt: project.revisitAt,
    project: parent ? { id: parent.id, title: parent.title } : null,
    completionCriteria: project.acceptanceCriteria.map((criterion) => ({ text: criterion.text, checked: criterion.checked })),
  };
}

function visibleScope(
  metadata: ActivityEventMetadata,
  entityId: number | null,
  current: Map<number, { scope: "household" | "work"; owner: number | null }>,
  subjectMemberId: number,
): "household" | "work" | null {
  const id = metadata.affectedWorkItemId ?? entityId;
  const row = id === null ? undefined : current.get(id);
  const scope = metadata.scope ?? row?.scope;
  if (scope === "household") return scope;
  if (scope !== "work") return null;
  const owner = metadata.after?.effectiveOwnerId ?? metadata.after?.ownerMemberId
    ?? metadata.before?.effectiveOwnerId ?? metadata.before?.ownerMemberId ?? row?.owner;
  return owner === subjectMemberId ? "work" : null;
}

const meaningfulKinds = new Set<string>([
  "task_created", "task_status_changed", "task_moved", "task_dependencies_changed",
  "task_external_wait_started", "task_external_wait_updated", "task_external_wait_resolved",
  "project_created", "project_status_changed", "project_acceptance_criterion_added",
  "project_acceptance_criterion_updated", "project_acceptance_criterion_checked",
  "project_acceptance_criterion_removed", "work_item_role_converted",
]);
const administrativeKinds = new Set<string>([
  "task_updated", "project_updated", "task_tags_changed", "task_contexts_changed",
  "project_tags_changed", "project_contexts_changed", "task_kind_changed",
]);

function eventItemId(event: { entityId: number | null; metadata: ActivityEventMetadata }): number | null {
  return event.metadata.affectedWorkItemId ?? event.entityId;
}

function renderMarkdown(briefing: Omit<ReflectionBriefing, "markdown">): string {
  const lines = [
    `# Rückblick: ${briefing.window.startDate} bis ${briefing.window.endDate}`,
    `Für ${briefing.subject.name} · ${briefing.window.days} Tage · Zeitzone ${briefing.timezone} · Bereich: ${briefing.scope}`,
    "",
    "## Aktueller Stand",
  ];
  const list = (title: string, items: ReflectionWorkItemFact[]) => {
    lines.push(`### ${title}`);
    if (!items.length) lines.push("- Keine Einträge.");
    for (const item of items) {
      const owner = item.owner ? ` · ${item.owner.name}` : "";
      const area = item.areaTags.length ? ` · ${item.areaTags.join(", ")}` : "";
      const dates = [item.dueDate ? `Frist ${item.dueDate}` : null, item.scheduledDate ? `geplant ${item.scheduledDate}` : null, item.notBeforeDate ? `frühestens ab ${item.notBeforeDate}` : item.notBeforeAt ? `frühestens ab ${item.notBeforeAt}` : null, item.revisitAt ? `Wiedervorlage ${item.revisitAt}` : null].filter(Boolean).join(" · ");
      lines.push(`- [${item.title}](${item.href}) — ${item.status}${owner}${area}${dates ? ` · ${dates}` : ""}`);
      if (item.notes?.trim()) lines.push(`  - Notizen: ${item.notes.trim()}`);
      if (item.waitingFor) lines.push(`  - Wartet auf: ${item.waitingFor}`);
      if (item.dependencies?.length) lines.push(`  - Offene Abhängigkeit: ${item.dependencies.map((dependency) => dependency.title).join(", ")}`);
      if (item.completionCriteria?.length) lines.push(`  - Ergebnis: ${item.completionCriteria.map((criterion) => `${criterion.checked ? "✓" : "○"} ${criterion.text}`).join("; ")}`);
    }
  };
  list("Aktive Projekte", briefing.current.activeProjects);
  list("Ausführbare nächste Schritte", briefing.current.executableNextActions);
  list("Warten und Abhängigkeiten", briefing.current.waitingItems);
  list("Backlog und später", briefing.current.backlog);
  list("Bereiche und Verpflichtungen", briefing.current.areaCommitments);
  lines.push("", "## Erledigt und verändert");
  lines.push(`- Endliche Ergebnisse: ${briefing.history.finiteCompletions.length}; administrative Änderungen: ${briefing.history.activityCounts.administrative}; Meilensteine: ${briefing.history.activityCounts.milestones}.`);
  for (const item of briefing.history.finiteCompletions) lines.push(`- ${item.date}: ${item.type === "project" ? "Projekt abgeschlossen" : "Aufgabe erledigt"}: ${item.href ? `[${item.title}](${item.href})` : item.title}.`);
  for (const group of briefing.history.bulkCompletionGroups) lines.push(`- ${group.date}: ${group.count} Unteraufgaben in „${group.title}“ gemeinsam abgeschlossen ([Eintrag](${group.href})); einzelne Aufgaben sind im Ereignis nicht benannt.`);
  for (const item of briefing.history.recurringWork) lines.push(`- Routine „${item.title}“: ${item.completed} erledigt, ${item.missed} verpasst (${item.representatives.map((entry) => `${entry.date} ${entry.result === "hit" ? "erledigt" : "verpasst"}`).join(", ")}).`);
  if (briefing.history.postponements.length) {
    lines.push("", "## Explizit später geplant");
    for (const item of briefing.history.postponements) lines.push(`- ${item.date}: [${item.title}](${item.href}) von ${item.from} auf ${item.to} verschoben.`);
  }
  if (briefing.history.inactiveWork.length) {
    lines.push("", "## Wenig dokumentierter Fortschritt");
    for (const item of briefing.history.inactiveWork) lines.push(`- [${item.title}](${item.href}): ${item.lastMeaningfulProgressAt ? `letzter erfasster Fortschritt ${item.lastMeaningfulProgressAt}` : "kein Fortschrittsereignis in der verfügbaren Historie"}.`);
  }
  if (briefing.history.evidence.notes.length) {
    lines.push("", "## Hinweise zur Datenlage");
    for (const note of briefing.history.evidence.notes) lines.push(`- ${note}`);
  }
  lines.push("", "Daten und Zeitangaben beschreiben dokumentierte Machbar-Ereignisse; sie erklären keine Ursachen.");
  return lines.join("\n");
}

export function buildReflectionBriefing(db: Db, options: ReflectionBriefingOptions): ReflectionBriefing {
  const subject = db.select({ id: schema.members.id, name: schema.members.name }).from(schema.members)
    .where(eq(schema.members.id, options.subjectMemberId)).get();
  if (!subject) throw AppError.notFound("member_not_found", "The selected member does not exist.");
  const timezone = validTimezone(db);
  const now = options.now ?? new Date();
  const endDate = localDate(now, timezone);
  const startDate = shiftDate(endDate, -(options.days - 1));
  const today = endDate;
  const graph = Graph.load(db, today, options.subjectMemberId, now.toISOString());
  const memberNames = new Map(db.select({ id: schema.members.id, name: schema.members.name }).from(schema.members).all().map((member) => [member.id, member.name]));
  const inScope = (scope: "household" | "work") => options.scope === "all" || options.scope === scope;
  const allTasks = graph.allTasks().filter((task) => inScope(task.scope));
  const projects = [...graph.projectsById.values()].filter((project) => inScope(project.scope));
  const fact = (task: TaskRecord) => factForTask(task, graph, memberNames);
  const activeProjects = projects.filter((project) => project.status === "active").map((project) => factForProject(project, graph, memberNames));
  const executableNextActions = allTasks.filter((task) => task.kind === "action" && task.status === "actionable" && task.executable && !task.blocked && !task.needsClarification)
    .filter((task) => task.projectId === null || graph.nextActionFor(task.projectId)?.id === task.id || task.additionalNextAction)
    .map(fact);
  const waitingItems = allTasks.filter((task) => task.status === "actionable" && (task.externalWait !== null || task.blocked)).map(fact);
  const backlog = [
    ...projects.filter((project) => project.status === "backlog").map((project) => factForProject(project, graph, memberNames)),
    ...allTasks.filter((task) => task.status === "someday" || task.status === "captured").map(fact),
  ];
  const areaCommitments = [
    ...projects.filter((project) => project.status === "active" && project.effectiveTags.some((tag) => tag.kind === "area")).map((project) => factForProject(project, graph, memberNames)),
    ...allTasks.filter((task) => task.status === "actionable" && task.effectiveAreaTags.length > 0)
      .filter((task) => task.scope === "household" || task.effectiveOwnerId === options.subjectMemberId)
      .map(fact),
  ];

  const currentItems = db.select({ id: schema.workItems.id, scope: schema.workItems.scope, role: schema.workItems.role, ownerMemberId: schema.workItems.ownerMemberId })
    .from(schema.workItems).all();
  const owners = getEffectiveOwners(db);
  const currentVisibility = new Map(currentItems.map((row) => [row.id, { scope: row.scope as "household" | "work", owner: row.role === "task" ? owners.get(row.id)?.ownerId ?? null : row.ownerMemberId }]));
  // Include a 24-hour UTC cushion around local date boundaries, then apply
  // the exact household-calendar range below. This remains correct for IANA
  // zones at either end of the UTC offset range.
  const lowerBound = new Date(`${startDate}T00:00:00.000Z`);
  lowerBound.setUTCDate(lowerBound.getUTCDate() - 1);
  const upperBound = new Date(`${shiftDate(endDate, 1)}T00:00:00.000Z`);
  upperBound.setUTCDate(upperBound.getUTCDate() + 1);
  const eventRows = db.select().from(schema.activityEvents).where(and(
    gte(schema.activityEvents.createdAt, lowerBound.toISOString()),
    lt(schema.activityEvents.createdAt, upperBound.toISOString()),
  )).all();
  const inWindow = eventRows.filter((event) => {
    const date = localDate(new Date(event.createdAt), timezone);
    return date >= startDate && date <= endDate;
  }).filter((event) => {
    const scope = visibleScope(event.metadata, event.entityId, currentVisibility, options.subjectMemberId);
    return scope !== null && inScope(scope);
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);

  const finiteCompletions: ReflectionBriefing["history"]["finiteCompletions"] = [];
  const completionEvents = inWindow.filter((event) => (event.kind === "task_status_changed" && event.metadata.nextStatus === "done") || (event.kind === "project_status_changed" && event.metadata.nextStatus === "completed"));
  for (const event of completionEvents) {
    if (event.metadata.recurrenceOccurrenceId) continue;
    const id = eventItemId(event);
    const laterReopen = id !== null && inWindow.some((later) => later.createdAt > event.createdAt && eventItemId(later) === id && ((later.kind === "task_status_changed" && ["actionable", "captured", "someday"].includes(String(later.metadata.nextStatus))) || (later.kind === "project_status_changed" && ["active", "backlog"].includes(String(later.metadata.nextStatus)))));
    if (laterReopen) continue;
    const type = event.entityType;
    finiteCompletions.push({ id, type, title: event.entityTitle, date: localDate(new Date(event.createdAt), timezone), href: id === null ? null : `#/${type === "project" ? "projects" : "tasks"}/${id}` });
  }
  const bulkCompletionGroups = inWindow.filter((event) => event.kind === "task_descendants_status_changed" && event.metadata.nextStatus === "done" && (event.metadata.affectedCount ?? 0) > 0)
    .flatMap((event) => {
      const id = eventItemId(event);
      return id === null ? [] : [{ id, title: event.entityTitle, date: localDate(new Date(event.createdAt), timezone), count: event.metadata.affectedCount!, href: `#/tasks/${id}` }];
    });

  const recurringTaskIds = allTasks.filter((task) => task.repeatAfterDays !== null).map((task) => task.id);
  const occurrenceRows = recurringTaskIds.length === 0 ? [] : db.select({ id: schema.taskRecurrenceOccurrences.id, taskId: schema.taskRecurrenceOccurrences.taskId, completedOn: schema.taskRecurrenceOccurrences.completedOn, completedAt: schema.taskRecurrenceOccurrences.completedAt, result: schema.taskRecurrenceOccurrences.result })
    .from(schema.taskRecurrenceOccurrences).where(and(
      inArray(schema.taskRecurrenceOccurrences.taskId, recurringTaskIds),
      gte(schema.taskRecurrenceOccurrences.completedOn, startDate),
      lt(schema.taskRecurrenceOccurrences.completedOn, shiftDate(endDate, 1)),
    )).all();
  const recurringByTask = new Map<number, typeof occurrenceRows>();
  for (const row of occurrenceRows) recurringByTask.set(row.taskId, [...(recurringByTask.get(row.taskId) ?? []), row]);
  const recurringWork: ReflectionBriefing["history"]["recurringWork"] = [...recurringByTask.entries()].map(([taskId, rows]) => {
    const task = graph.tasksById.get(taskId)!;
    const visible = inScope(task.scope);
    const selected = visible ? rows.sort((a, b) => a.completedAt.localeCompare(b.completedAt)) : [];
    return { taskId, title: task.title, completed: selected.filter((row) => row.result === "hit").length, missed: selected.filter((row) => row.result === "miss").length, representatives: selected.slice(0, 5).map((row) => ({ date: row.completedOn, result: row.result })) };
  }).filter((item) => item.completed + item.missed > 0);

  const postponements: ReflectionBriefing["history"]["postponements"] = [];
  for (const event of inWindow) {
    if ((event.kind !== "task_updated" && event.kind !== "project_updated") || !event.metadata.changedFields?.includes("scheduledDate") || event.metadata.recurrenceOccurrenceId || event.metadata.nextScheduledDate) continue;
    const from = event.metadata.before?.scheduledDate;
    const to = event.metadata.after?.scheduledDate;
    const id = eventItemId(event);
    if (!from || !to || to <= from || id === null) continue;
    postponements.push({ id, type: event.entityType, title: event.entityTitle, date: localDate(new Date(event.createdAt), timezone), from, to, href: `#/${event.entityType === "project" ? "projects" : "tasks"}/${id}` });
  }

  const inactiveCandidates: Array<TaskRecord | ProjectRecord> = [
    ...projects.filter((project) => project.status === "active"),
    ...allTasks.filter((task) => task.kind === "action" && task.status === "actionable" && (Date.parse(now.toISOString()) - Date.parse(task.createdAt) >= options.days * 86400000)),
  ];
  const candidateIds = new Set<number>();
  for (const candidate of inactiveCandidates) {
    candidateIds.add(candidate.id);
    if ("role" in candidate || "childStories" in candidate) for (const task of graph.tasksForProject(candidate.id)) candidateIds.add(task.id);
  }
  const meaningfulHistoryRows = candidateIds.size === 0 ? [] : db.select().from(schema.activityEvents)
    .where(inArray(schema.activityEvents.entityId, [...candidateIds])).all();
  const meaningfulRows = meaningfulHistoryRows.filter((event) => {
    const id = eventItemId(event);
    if (!meaningfulKinds.has(event.kind) && !(administrativeKinds.has(event.kind) && event.metadata.changedFields?.some((field) => ["title", "notes"].includes(field)))) return false;
    const ctxProject = event.metadata.projectContextId ?? (id === null ? null : graph.tasksById.get(id)?.projectId ?? null);
    return (id !== null && candidateIds.has(id)) || (ctxProject !== undefined && ctxProject !== null && candidateIds.has(ctxProject));
  }).filter((event) => {
    const visibility = visibleScope(event.metadata, event.entityId, currentVisibility, options.subjectMemberId);
    return visibility !== null && inScope(visibility);
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  const inactiveWork: ReflectionBriefing["history"]["inactiveWork"] = inactiveCandidates.map((candidate) => {
    const id = candidate.id;
    const projectCandidate = "childStories" in candidate;
    const events = meaningfulRows.filter((event) => eventItemId(event) === id || event.metadata.projectContextId === id);
    const last = events.at(-1)?.createdAt ?? null;
    return {
      id, type: projectCandidate ? "project" as const : "task" as const,
      title: candidate.title, href: `#/${projectCandidate ? "projects" : "tasks"}/${id}`,
      lastMeaningfulProgressAt: last,
      evidence: last === null ? "no_recorded_progress" as const : "known" as const,
      oldEnough: Date.parse(now.toISOString()) - Date.parse(candidate.createdAt) >= options.days * 86400000,
    };
  }).filter((item) => item.oldEnough && (item.lastMeaningfulProgressAt === null || Date.parse(now.toISOString()) - Date.parse(item.lastMeaningfulProgressAt) >= options.days * 86400000))
    .map(({ oldEnough: _oldEnough, ...item }) => item);

  const base: Omit<ReflectionBriefing, "markdown"> = {
    generatedAt: now.toISOString(), subject, scope: options.scope, timezone,
    window: { days: options.days, startDate, endDate },
    current: { activeProjects, executableNextActions, waitingItems, backlog, areaCommitments },
    history: {
      finiteCompletions,
      bulkCompletionGroups,
      recurringWork,
      inactiveWork,
      postponements,
      activityCounts: {
        administrative: inWindow.filter((event) => administrativeKinds.has(event.kind) || (event.metadata.changedFields?.length && event.metadata.changedFields.every((field) => ["ownerMemberId", "reviewedAt", "tagIds", "contextIds"].includes(field)))).length,
        finiteOutcomes: finiteCompletions.length,
        milestones: inWindow.filter((event) => event.kind === "project_status_changed" && ["active", "completed"].includes(String(event.metadata.nextStatus))).length,
      },
      evidence: {
        incomplete: true,
        notes: ["Die Historie zeigt erfasste Machbar-Ereignisse. Fehlende oder gelöschte Einträge belegen keinen fehlenden Fortschritt."],
      },
    },
  };
  return { ...base, markdown: renderMarkdown(base) };
}
