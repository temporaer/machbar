import type { ReflectionBriefing, ReflectionBriefingScope, ReflectionWorkItemFact, ActivityEventMetadata } from "@machbar/shared";
import { DEFAULT_HOUSEHOLD_TIMEZONE } from "@machbar/shared";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { Graph, type TaskRecord, type ProjectRecord } from "../domain/graph.js";
import { getEffectiveOwners } from "../repo/effectiveRepo.js";

export interface ReflectionBriefingOptions { subjectMemberId: number; days: 30 | 90 | 180; scope: ReflectionBriefingScope; now?: Date }
type Scope = "household" | "work";
type CurrentVisibility = { scope: Scope; owner: number | null };

function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function shiftDate(date: string, days: number): string { const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function validTimezone(db: Db): string {
  const value = db.select({ value: schema.householdSettings.value }).from(schema.householdSettings).where(eq(schema.householdSettings.key, "timezone")).get()?.value ?? DEFAULT_HOUSEHOLD_TIMEZONE;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return value; } catch { return DEFAULT_HOUSEHOLD_TIMEZONE; }
}
function factForTask(task: TaskRecord, graph: Graph, names: Map<number, string>): ReflectionWorkItemFact {
  return { id: task.id, type: "task", title: task.title, status: task.status, scope: task.scope, notes: task.notes, href: `#/tasks/${task.id}`,
    owner: task.effectiveOwnerId === null ? null : { id: task.effectiveOwnerId, name: names.get(task.effectiveOwnerId) ?? `Mitglied ${task.effectiveOwnerId}` },
    areaTags: task.effectiveAreaTags.map((tag) => tag.name), dueDate: task.dueDate, scheduledDate: task.scheduledDate, revisitAt: task.revisitAt,
    notBeforeAt: task.notBeforeAt, notBeforeDate: task.notBeforeDate,
    project: task.projectId === null ? null : (() => { const p = graph.projectsById.get(task.projectId!); return p ? { id: p.id, title: p.title } : null; })(),
    waitingFor: task.externalWait?.waitingFor ?? null,
    dependencies: task.dependencies.filter((d) => !d.resolved).map((d) => ({ id: d.dependsOnTaskId, title: d.title ?? `Aufgabe ${d.dependsOnTaskId}`, resolved: false })) };
}
function factForProject(project: ProjectRecord, graph: Graph, names: Map<number, string>): ReflectionWorkItemFact {
  const parent = project.parentId === null ? undefined : graph.projectsById.get(project.parentId);
  return { id: project.id, type: "project", title: project.title, status: project.status, scope: project.scope, notes: project.notes, href: `#/projects/${project.id}`,
    owner: project.ownerMemberId === null ? null : { id: project.ownerMemberId, name: names.get(project.ownerMemberId) ?? `Mitglied ${project.ownerMemberId}` },
    areaTags: project.effectiveTags.filter((tag) => tag.kind === "area").map((tag) => tag.name), dueDate: project.dueDate, scheduledDate: project.scheduledDate, revisitAt: project.revisitAt,
    project: parent ? { id: parent.id, title: parent.title } : null, completionCriteria: project.acceptanceCriteria.map((c) => ({ text: c.text, checked: c.checked })) };
}

function has(object: object | undefined, key: string): boolean { return object !== undefined && Object.prototype.hasOwnProperty.call(object, key); }
function snapshotOwner(metadata: ActivityEventMetadata): { known: boolean; owner: number | null } {
  for (const snapshot of [metadata.after, metadata.before]) {
    if (has(snapshot, "effectiveOwnerId")) return { known: true, owner: snapshot!.effectiveOwnerId ?? null };
    if (has(snapshot, "ownerMemberId")) return { known: true, owner: snapshot!.ownerMemberId ?? null };
  }
  return { known: false, owner: null };
}
function visibleScope(metadata: ActivityEventMetadata, entityId: number | null, current: Map<number, CurrentVisibility>, subject: number): Scope | null {
  const id = metadata.affectedWorkItemId ?? entityId;
  const row = id === null ? undefined : current.get(id);
  // A currently private item is only visible to its current owner, regardless of historical scope.
  if (row?.scope === "work" && row.owner !== subject) return null;
  // Event-time scope is required; current scope is not a historical substitute.
  const eventScope = metadata.scope;
  if (eventScope !== "household" && eventScope !== "work") return null;
  if (eventScope === "work") {
    const owner = snapshotOwner(metadata);
    if (!owner.known || owner.owner !== subject) return null;
  }
  // A scope transition without a before snapshot cannot establish where the event began.
  if (metadata.changedFields?.includes("scope")) return null;
  return eventScope;
}
function eventItemId(event: { entityId: number | null; metadata: ActivityEventMetadata }): number | null { return event.metadata.affectedWorkItemId ?? event.entityId; }
const adminKinds = new Set(["task_created", "project_created", "task_updated", "project_updated", "task_moved", "task_dependencies_changed", "task_tags_changed", "task_contexts_changed", "project_tags_changed", "project_contexts_changed", "task_kind_changed", "project_acceptance_criterion_added", "project_acceptance_criterion_updated", "project_acceptance_criterion_removed", "project_status_changed", "task_external_wait_started", "task_external_wait_updated", "task_external_wait_resolved"]);
function isOutcome(event: { kind: string; entityType: string; metadata: ActivityEventMetadata }): boolean {
  if (event.kind === "task_status_changed" && event.metadata.nextStatus === "done" && !event.metadata.recurrenceOccurrenceId) return true;
  if (event.kind === "project_status_changed" && event.metadata.nextStatus === "completed") return true;
  return event.kind === "project_acceptance_criterion_checked" && event.metadata.checked === true;
}
function markdownRef(id: number | null, type: "task" | "project"): string { return id === null ? "ID unbekannt" : `ID ${id} · /${type === "project" ? "projects" : "tasks"}/${id}`; }
function bounded<T>(lines: string[], label: string, values: T[], limit: number, format: (item: T) => string): void {
  lines.push(`### ${label} (${values.length})`);
  if (!values.length) { lines.push("- Keine dokumentierten Einträge."); return; }
  // Stable order: dated evidence chronologically, then title, then numeric ID.
  const ordered = [...values].sort((left, right) => {
    const a = left as { date?: string; title?: string; id?: number; taskId?: number };
    const b = right as { date?: string; title?: string; id?: number; taskId?: number };
    const dateOrder = (a.date ?? "").localeCompare(b.date ?? "");
    return dateOrder || (a.title ?? "").localeCompare(b.title ?? "", "de") || (a.id ?? a.taskId ?? 0) - (b.id ?? b.taskId ?? 0);
  });
  for (const item of ordered.slice(0, limit)) lines.push(`- ${format(item)}`);
  if (values.length > limit) lines.push(`- ${values.length - limit} weitere Einträge ausgelassen.`);
}
function renderMarkdown(b: Omit<ReflectionBriefing, "markdown">): string {
  const h = b.history;
  const lines = [`# Historische Reflexion · ${b.window.startDate} bis ${b.window.endDate}`, `Für ${b.subject.name} · ${b.window.days} Tage · ${b.timezone} · Bereich ${b.scope}`, "",
    "## Überblick", `- Datenbasis: ${h.evidence.incomplete ? "unvollständig; siehe Einschränkungen" : "vollständig"}. Erfasst: ${h.activityCounts.administrative} Planungs-/Verwaltungsereignisse.`,
    `- Aktive Verpflichtungen: ${b.current.activeProjects.length + b.current.executableNextActions.length}; endliche aufgezeichnete Ergebnisse: ${h.finiteCompletions.length}; wiederkehrende Arbeit: ${h.activityCounts.recurringOccurrences} Vorkommnisse; explizite Verschiebungen: ${h.postponements.length}; offene aktive Arbeit: ${h.activityCounts.unresolvedActiveWork}.`, "",
    "## Wo Fortschritt dokumentiert wurde"];
  bounded(lines, "Aufgezeichnete endliche Ergebnisse", h.finiteCompletions, 12, (x) => `${x.date}: ${x.type === "project" ? "Projekt" : "Aufgabe"} „${x.title}“ (${markdownRef(x.id, x.type)})${x.currentItemAvailable ? "" : " · aktueller Eintrag nicht verfügbar"}. Das belegt ein erfasstes Ergebnis, nicht das Erreichen eines übergeordneten Ziels.`);
  bounded(lines, "Projekte mit verknüpften Aufgaben-Ergebnissen", h.progress.projectsWithRecordedChildOutcomes, 10, (x) => `${x.date}: „${x.title}“ erhielt ein aufgezeichnetes Ergebnis für „${x.childTitle}“ (Projekt-ID ${x.id}, Aufgabe-ID ${x.childId}).`);
  bounded(lines, "Abgehakte Projekt-Erfolgskriterien", h.progress.checkedAcceptanceCriteria, 10, (x) => `${x.date}: Ein Kriterium für „${x.projectTitle}“ wurde abgehakt (Projekt-ID ${x.projectId}).`);
  bounded(lines, "Verifizierte Entblockierungen", h.progress.verifiedUnblocking, 10, (x) => `${x.date}: „${x.title}“ · ${x.reason} (${markdownRef(x.id, x.type)}).`);
  lines.push("", "## Verpflichtungen, die Aufmerksamkeit brauchen");
  const actionable = h.inactiveWork.filter((x) => x.classification === "actionable_no_recorded_progress");
  bounded(lines, "Ausführbar, ohne aufgezeichnetes Ergebnis im Zeitraum", actionable, 12, (x) => `„${x.title}“ (${markdownRef(x.id, x.type)}; Status ${x.status})${x.lastOutcomeProgressAt ? ` · letztes verifiziertes Ergebnis ${x.lastOutcomeProgressAt.slice(0, 10)}` : " · im verfügbaren Verlauf kein Ergebnis verifizierbar"}${x.lastActivityAt ? ` · letzte Aktivität ${x.lastActivityAt.slice(0, 10)}` : ""}${x.waitingReason ? ` · ${x.waitingReason}` : ""}${x.evidenceLimitations.length ? ` · Einschränkung: ${x.evidenceLimitations.join("; ")}` : ""}.`);
  const repeats = new Map<number, typeof h.postponements>(); for (const p of h.postponements) repeats.set(p.id, [...(repeats.get(p.id) ?? []), p]);
  const repeated = [...repeats.values()].filter((v) => v.length > 1).sort((a, b) => b.length - a.length || a[0]!.title.localeCompare(b[0]!.title, "de"));
  bounded(lines, "Mehrfach ausdrücklich verschoben", repeated, 10, (items) => `„${items[0]!.title}“ (${markdownRef(items[0]!.id, items[0]!.type)} · ${items.length} Verschiebungen; zuletzt ${items.at(-1)!.from} → ${items.at(-1)!.to}).`);
  lines.push("", "## Muster zum Besprechen", `- Aufgezeichnete endliche Ergebnisse: ${h.finiteCompletions.length}; wiederkehrende Vorkommnisse: ${h.activityCounts.recurringOccurrences}; Planungs-/Verwaltungsereignisse: ${h.activityCounts.administrative}. Diese Arten von Aktivität belegen Unterschiedliches und erklären keine Ursachen.`, "",
    "## Aktuelle Verpflichtungen und Bereiche");
  const compact = (x: ReflectionWorkItemFact) => `„${x.title}“ (${markdownRef(x.id, x.type)}; ${x.status})${x.areaTags.length ? ` · ${x.areaTags.join(", ")}` : ""}${x.scheduledDate ? ` · geplant ${x.scheduledDate}` : ""}${x.revisitAt ? ` · Wiedervorlage ${x.revisitAt}` : ""}${x.waitingFor ? ` · wartet auf ${x.waitingFor}` : ""}`;
  bounded(lines, "Aktive Projekte", b.current.activeProjects, 10, compact);
  bounded(lines, "Eigenständige nächste Schritte", b.current.executableNextActions.filter((x) => x.project === null), 12, compact);
  bounded(lines, "Warten / blockiert", b.current.waitingItems, 10, compact);
  bounded(lines, "Backlog / später", b.current.backlog, 10, compact);
  bounded(lines, "Bereiche", b.current.areaCommitments, 10, compact);
  lines.push("", "## Einschränkungen der Datenlage");
  for (const note of h.evidence.notes.slice(0, 10)) lines.push(`- ${note}`);
  if (h.evidence.notes.length > 10) lines.push(`- ${h.evidence.notes.length - 10} weitere Hinweise ausgelassen.`);
  lines.push("- Fehlende Machbar-Ereignisse belegen weder Untätigkeit noch Gründe oder Motive.");
  return lines.join("\n");
}

export function buildReflectionBriefing(db: Db, options: ReflectionBriefingOptions): ReflectionBriefing {
  const subject = db.select({ id: schema.members.id, name: schema.members.name }).from(schema.members).where(eq(schema.members.id, options.subjectMemberId)).get();
  if (!subject) throw AppError.notFound("member_not_found", "The selected member does not exist.");
  const timezone = validTimezone(db); const now = options.now ?? new Date(); const endDate = localDate(now, timezone); const startDate = shiftDate(endDate, -(options.days - 1));
  const graph = Graph.load(db, endDate, options.subjectMemberId, now.toISOString());
  const memberNames = new Map(db.select({ id: schema.members.id, name: schema.members.name }).from(schema.members).all().map((m) => [m.id, m.name]));
  const inScope = (scope: Scope) => options.scope === "all" || options.scope === scope;
  const tasks = graph.allTasks().filter((t) => inScope(t.scope)); const projects = [...graph.projectsById.values()].filter((p) => inScope(p.scope));
  const fact = (t: TaskRecord) => factForTask(t, graph, memberNames);
  const activeProjects = projects.filter((p) => p.status === "active").map((p) => factForProject(p, graph, memberNames));
  const executableNextActions = tasks.filter((t) => t.kind === "action" && t.status === "actionable" && t.executable && !t.blocked && !t.needsClarification).filter((t) => t.projectId === null || graph.nextActionFor(t.projectId)?.id === t.id || t.additionalNextAction).map(fact);
  const waitingItems = tasks.filter((t) => t.status === "actionable" && (t.externalWait !== null || t.blocked || (t.revisitAt !== null && t.revisitAt > now.toISOString()))).map(fact);
  const backlog = [...projects.filter((p) => p.status === "backlog").map((p) => factForProject(p, graph, memberNames)), ...tasks.filter((t) => t.status === "someday" || t.status === "captured").map(fact)];
  const areaCommitments = [...projects.filter((p) => p.status === "active" && p.effectiveTags.some((tag) => tag.kind === "area")).map((p) => factForProject(p, graph, memberNames)), ...tasks.filter((t) => t.status === "actionable" && t.effectiveAreaTags.length > 0 && (t.scope === "household" || t.effectiveOwnerId === options.subjectMemberId)).map(fact)];
  const currentRows = db.select({ id: schema.workItems.id, scope: schema.workItems.scope, role: schema.workItems.role, ownerMemberId: schema.workItems.ownerMemberId }).from(schema.workItems).all();
  const owners = getEffectiveOwners(db);
  const currentVisibility = new Map<number, CurrentVisibility>(currentRows.map((r) => [r.id, { scope: r.scope as Scope, owner: r.role === "task" ? owners.get(r.id)?.ownerId ?? null : r.ownerMemberId }]));
  const lower = new Date(`${startDate}T00:00:00Z`); lower.setUTCDate(lower.getUTCDate() - 1); const upper = new Date(`${shiftDate(endDate, 1)}T00:00:00Z`); upper.setUTCDate(upper.getUTCDate() + 1);
  const eventRows = db.select().from(schema.activityEvents).where(and(gte(schema.activityEvents.createdAt, lower.toISOString()), lt(schema.activityEvents.createdAt, upper.toISOString()))).all();
  let excludedHistorical = false;
  const inWindow = eventRows.filter((e) => { const d = localDate(new Date(e.createdAt), timezone); return d >= startDate && d <= endDate; }).filter((e) => {
    const scope = visibleScope(e.metadata, e.entityId, currentVisibility, options.subjectMemberId);
    if (!scope || !inScope(scope)) { excludedHistorical = true; return false; } return true;
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);

  const currentType = new Map(currentRows.map((r) => [r.id, r.role === "story" ? "project" as const : "task" as const]));
  const outcomes = inWindow.filter(isOutcome);
  const finiteOutcomeEvents = outcomes.filter((e) => (e.kind === "task_status_changed" && e.metadata.nextStatus === "done" && !e.metadata.recurrenceOccurrenceId) || (e.kind === "project_status_changed" && e.metadata.nextStatus === "completed"));
  const finiteCompletions: ReflectionBriefing["history"]["finiteCompletions"] = [];
  const latestCompletionById = new Map<number, typeof finiteOutcomeEvents[number]>();
  for (const ev of finiteOutcomeEvents) {
    const id = eventItemId(ev); if (id === null) { finiteCompletions.push({ id: null, type: ev.kind.startsWith("project_") ? "project" : "task", title: ev.entityTitle, date: localDate(new Date(ev.createdAt), timezone), href: null, currentItemAvailable: false }); continue; }
    const prior = latestCompletionById.get(id); if (prior && prior.createdAt >= ev.createdAt) continue;
    latestCompletionById.set(id, ev);
  }
  for (const [id, ev] of latestCompletionById) {
    // Only retain completion cycles that end in completion; a later reopen supersedes that outcome.
    const later = inWindow.filter((x) => eventItemId(x) === id && x.createdAt > ev.createdAt);
    const reopened = later.some((x) => (x.kind === "task_status_changed" && ["actionable", "captured", "someday", "cancelled"].includes(String(x.metadata.nextStatus))) || (x.kind === "project_status_changed" && ["active", "backlog", "cancelled"].includes(String(x.metadata.nextStatus))));
    if (reopened) continue;
    const historicalType = ev.kind.startsWith("project_") ? "project" : "task";
    const sameCurrentRole = currentType.get(id) === historicalType;
    finiteCompletions.push({ id, type: historicalType, title: ev.entityTitle, date: localDate(new Date(ev.createdAt), timezone), href: sameCurrentRole ? `#/${historicalType === "project" ? "projects" : "tasks"}/${id}` : null, currentItemAvailable: sameCurrentRole });
  }
  finiteCompletions.sort((a, b) => a.date.localeCompare(b.date) || (a.id ?? 0) - (b.id ?? 0));
  const bulkCompletionGroups = inWindow.filter((e) => e.kind === "task_descendants_status_changed" && e.metadata.nextStatus === "done" && (e.metadata.affectedCount ?? 0) > 0).flatMap((e) => { const id = eventItemId(e); return id === null ? [] : [{ id, title: e.entityTitle, date: localDate(new Date(e.createdAt), timezone), count: e.metadata.affectedCount!, href: currentType.get(id) === "task" ? `#/tasks/${id}` : null }]; });
  // Occurrences are queried by their own historical dates, independent of today's repeatAfterDays setting.
  const occurrenceRows = db.select({ id: schema.taskRecurrenceOccurrences.id, taskId: schema.taskRecurrenceOccurrences.taskId, completedOn: schema.taskRecurrenceOccurrences.completedOn, completedAt: schema.taskRecurrenceOccurrences.completedAt, result: schema.taskRecurrenceOccurrences.result }).from(schema.taskRecurrenceOccurrences).where(and(gte(schema.taskRecurrenceOccurrences.completedOn, startDate), lt(schema.taskRecurrenceOccurrences.completedOn, shiftDate(endDate, 1)))).all();
  const visibleOccurrenceIds = new Set(inWindow.filter((e) => e.metadata.recurrenceOccurrenceId !== undefined).map((e) => e.metadata.recurrenceOccurrenceId));
  const recurringWork: ReflectionBriefing["history"]["recurringWork"] = [];
  const occurrencesByTask = new Map<number, typeof occurrenceRows>();
  for (const row of occurrenceRows.filter((r) => visibleOccurrenceIds.has(r.id))) occurrencesByTask.set(row.taskId, [...(occurrencesByTask.get(row.taskId) ?? []), row]);
  for (const [taskId, rows] of occurrencesByTask) {
    const t = graph.tasksById.get(taskId); if (!t || !inScope(t.scope)) continue;
    const selected = rows.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    recurringWork.push({ taskId, title: t.title, completed: selected.filter((r) => r.result === "hit").length, missed: selected.filter((r) => r.result === "miss").length, representatives: selected.slice(0, 5).map((r) => ({ date: r.completedOn, result: r.result })) });
  }
  recurringWork.sort((a, b) => a.title.localeCompare(b.title, "de") || a.taskId - b.taskId);
  const postponements: ReflectionBriefing["history"]["postponements"] = [];
  for (const e of inWindow) {
    if ((e.kind !== "task_updated" && e.kind !== "project_updated") || !e.metadata.changedFields?.includes("scheduledDate") || e.metadata.recurrenceOccurrenceId || e.metadata.nextScheduledDate) continue;
    const from = e.metadata.before?.scheduledDate; const to = e.metadata.after?.scheduledDate; const id = eventItemId(e); if (!from || !to || to <= from || id === null) continue;
    postponements.push({ id, type: currentType.get(id) ?? (e.kind.startsWith("project_") ? "project" : "task"), title: e.entityTitle, date: localDate(new Date(e.createdAt), timezone), from, to, href: currentType.get(id) === (e.kind.startsWith("project_") ? "project" : "task") ? `#/${currentType.get(id) === "project" ? "projects" : "tasks"}/${id}` : null });
  }
  const byId = new Map<number, typeof inWindow>();
  for (const e of inWindow) { const id = eventItemId(e); if (id !== null) byId.set(id, [...(byId.get(id) ?? []), e]); }
  const outcomeDates = new Map<number, string>(); const enablingDates = new Map<number, string>(); const activityDates = new Map<number, string>();
  const projectsWithRecordedChildOutcomes: ReflectionBriefing["history"]["progress"]["projectsWithRecordedChildOutcomes"] = [];
  const checkedAcceptanceCriteria: ReflectionBriefing["history"]["progress"]["checkedAcceptanceCriteria"] = [];
  const verifiedUnblocking: ReflectionBriefing["history"]["progress"]["verifiedUnblocking"] = [];
  for (const e of inWindow) {
    const id = eventItemId(e); const date = e.createdAt;
    if (isOutcome(e) && id !== null) outcomeDates.set(id, date);
    if (e.kind === "project_acceptance_criterion_checked" && e.metadata.checked === true && id !== null) checkedAcceptanceCriteria.push({ projectId: id, projectTitle: e.entityTitle, date: localDate(new Date(date), timezone) });
    if (id !== null) activityDates.set(id, date);
    const projectId = e.metadata.projectContextId;
    if (isOutcome(e) && e.entityType === "task" && projectId !== undefined && projectId !== null && currentType.get(projectId) === "project") projectsWithRecordedChildOutcomes.push({ id: projectId, title: currentRows.find((r) => r.id === projectId) ? (projects.find((p) => p.id === projectId)?.title ?? `Projekt ${projectId}`) : `Projekt ${projectId}`, date: localDate(new Date(date), timezone), childId: id!, childTitle: e.entityTitle });
    if (e.kind === "task_external_wait_resolved" && id !== null) { enablingDates.set(id, date); verifiedUnblocking.push({ id, type: currentType.get(id) ?? "task", title: e.entityTitle, date: localDate(new Date(date), timezone), reason: "Externe Wartebedingung explizit aufgelöst", href: currentType.get(id) === "task" ? `#/tasks/${id}` : null }); }
    if ((e.kind === "task_dependencies_changed" || e.kind === "task_status_changed") && (e.metadata.newlyExecutableTaskIds?.length ?? 0) > 0) for (const taskId of e.metadata.newlyExecutableTaskIds!) { enablingDates.set(taskId, date); verifiedUnblocking.push({ id: taskId, type: "task", title: currentRows.find((r) => r.id === taskId) ? (graph.tasksById.get(taskId)?.title ?? `Aufgabe ${taskId}`) : `Aufgabe ${taskId}`, date: localDate(new Date(date), timezone), reason: "Aktivität dokumentiert neu ausführbare Arbeit nach Auflösung eines Blockers", href: currentType.has(taskId) ? `#/tasks/${taskId}` : null }); }
  }
  const inactiveWork: ReflectionBriefing["history"]["inactiveWork"] = [];
  const oldEnough = (createdAt: string) => now.getTime() - Date.parse(createdAt) >= options.days * 86400000;
  const candidates: Array<{ item: TaskRecord | ProjectRecord; type: "task" | "project" }> = [
    ...projects.filter((p) => p.status === "active" && oldEnough(p.createdAt)).map((item) => ({ item, type: "project" as const })),
    ...tasks.filter((t) => t.kind === "action" && t.repeatAfterDays === null && t.status === "actionable" && oldEnough(t.createdAt)).map((item) => ({ item, type: "task" as const })),
  ];
  // Report the last verified outcome date even when it predates the selected lookback.
  // Project attribution still depends solely on the recorded historical projectContextId.
  const priorRows = db.select().from(schema.activityEvents).where(lt(schema.activityEvents.createdAt, lower.toISOString())).all();
  const priorVisible = priorRows.filter((e) => {
    const scope = visibleScope(e.metadata, e.entityId, currentVisibility, options.subjectMemberId);
    if (!scope || !inScope(scope)) { excludedHistorical = true; return false; }
    return isOutcome(e);
  });
  for (const { item, type } of candidates) {
    const itemEvents = byId.get(item.id) ?? [];
    const priorOutcomeDates = priorVisible.filter((e) => eventItemId(e) === item.id || (type === "project" && e.metadata.projectContextId === item.id)).map((e) => e.createdAt);
    const lastOutcomeProgressAt = [...priorOutcomeDates, ...[...outcomeDates.entries()].filter(([id]) => id === item.id).map(([, date]) => date), ...(type === "project" ? [...projectsWithRecordedChildOutcomes].filter((x) => x.id === item.id).map((x) => x.date) : [])].sort().at(-1) ?? null;
    const hadOutcomeInWindow = outcomeDates.has(item.id) || (type === "project" && projectsWithRecordedChildOutcomes.some((x) => x.id === item.id));
    const projectEvents = type === "project" ? inWindow.filter((e) => e.metadata.projectContextId === item.id) : [];
    const lastWorkEnablingProgressAt = enablingDates.get(item.id) ?? projectEvents.filter((e) => e.kind === "task_external_wait_resolved" || (e.metadata.newlyExecutableTaskIds?.length ?? 0) > 0).map((e) => e.createdAt).sort().at(-1) ?? null;
    const lastActivityAt = [activityDates.get(item.id) ?? null, ...projectEvents.map((e) => e.createdAt)].filter((x): x is string => x !== null).sort().at(-1) ?? null;
    let classification: ReflectionBriefing["history"]["inactiveWork"][number]["classification"];
    let waitingReason: string | null = null;
    let plannedDate: string | null = null; let revisitAt: string | null = null; let dueDate: string | null = null;
    if (type === "task") {
      const t = item as TaskRecord; plannedDate = t.scheduledDate; revisitAt = t.revisitAt; dueDate = t.dueDate;
      const blocker = graph.blockerAnalysisFor(t.id);
      if (t.externalWait) { classification = "intentional_wait"; waitingReason = t.externalWait.waitingFor; }
      else if (t.dependencies.some((d) => !d.resolved) && blocker?.healthyProgressPath) { classification = "intentional_wait"; waitingReason = "Gesunde blockierende Abhängigkeit"; }
      else if (t.revisitAt && t.revisitAt > now.toISOString()) { classification = "intentional_wait"; waitingReason = `Wiedervorlage am ${t.revisitAt}`; }
      else if ((t.notBeforeAt && t.notBeforeAt > now.toISOString()) || (t.notBeforeDate && t.notBeforeDate > endDate) || (t.scheduledDate && t.scheduledDate > endDate)) { classification = "future_planned"; plannedDate = t.scheduledDate ?? t.notBeforeDate ?? null; revisitAt = t.revisitAt; }
      else if (t.status === "actionable" && !t.blocked && t.executable) classification = hadOutcomeInWindow ? "insufficient_evidence" : "actionable_no_recorded_progress";
      else if (t.status === "actionable" && t.blocked) { classification = "intentional_wait"; waitingReason = t.dependencies.filter((d) => !d.resolved).map((d) => d.title ?? `Aufgabe ${d.dependsOnTaskId}`).join(", ") || "Blockierung dokumentiert"; }
      else classification = "insufficient_evidence";
    } else {
      const p = item as ProjectRecord; plannedDate = p.scheduledDate; revisitAt = p.revisitAt; dueDate = p.dueDate;
      if (p.revisitAt && p.revisitAt > now.toISOString()) { classification = "intentional_wait"; waitingReason = `Wiedervorlage am ${p.revisitAt}`; }
      else if (p.scheduledDate && p.scheduledDate > endDate) classification = "future_planned";
      else {
        const childTasks = graph.tasksForProject(p.id); const actionableChild = childTasks.some((t) => t.repeatAfterDays === null && t.status === "actionable" && t.executable && !t.blocked);
        const waitingChild = childTasks.some((t) => t.status === "actionable" && (t.externalWait || t.blocked));
        if (waitingChild && !actionableChild) { classification = "intentional_wait"; waitingReason = "Aktuelle nächste Arbeit wartet auf externe Rückmeldung oder Abhängigkeit"; }
        else if (actionableChild) classification = hadOutcomeInWindow ? "insufficient_evidence" : "actionable_no_recorded_progress";
        else classification = "insufficient_evidence";
      }
    }
    const limitations = itemEvents.length === 0 ? ["Kein sichtbares Ereignis im Zeitraum; das belegt nicht, dass keine Arbeit stattfand."] : [];
    if (excludedHistorical) limitations.push("Ein Teil der Historie wurde wegen fehlender oder nicht passender Berechtigungsnachweise ausgelassen.");
    inactiveWork.push({ id: item.id, type, title: item.title, href: `#/${type === "project" ? "projects" : "tasks"}/${item.id}`, classification, status: item.status, lastOutcomeProgressAt, lastWorkEnablingProgressAt, lastActivityAt, scheduledDate: plannedDate, revisitAt, dueDate, waitingReason, evidenceLimitations: limitations });
  }
  const counts = { administrative: inWindow.filter((e) => adminKinds.has(e.kind) || (e.kind === "task_status_changed" && e.metadata.nextStatus !== "done" && !e.metadata.recurrenceOccurrenceId) || e.metadata.changedFields?.some((f) => ["ownerMemberId", "reviewedAt", "tagIds", "contextIds", "title", "notes"].includes(f))).length, finiteOutcomes: finiteCompletions.length, milestones: inWindow.filter((e) => e.kind === "project_status_changed" && ["active", "completed"].includes(String(e.metadata.nextStatus))).length, recurringOccurrences: recurringWork.reduce((sum, x) => sum + x.completed + x.missed, 0), explicitPostponements: postponements.length, unresolvedActiveWork: inactiveWork.filter((x) => x.classification === "actionable_no_recorded_progress").length };
  const base: Omit<ReflectionBriefing, "markdown"> = { generatedAt: now.toISOString(), subject, scope: options.scope, timezone, window: { days: options.days, startDate, endDate }, current: { activeProjects, executableNextActions, waitingItems, backlog, areaCommitments }, history: {
    finiteCompletions, bulkCompletionGroups, recurringWork, inactiveWork, postponements,
    progress: { lastOutcomeProgressAt: [...outcomeDates.values()].sort().at(-1) ?? null, lastWorkEnablingProgressAt: [...enablingDates.values()].sort().at(-1) ?? null, lastActivityAt: [...activityDates.values()].sort().at(-1) ?? null, projectsWithRecordedChildOutcomes, checkedAcceptanceCriteria, verifiedUnblocking },
    activityCounts: counts, evidence: { incomplete: true, notes: ["Die Historie beschreibt dokumentierte Machbar-Ereignisse, nicht alle tatsächlich geleistete Arbeit.", ...(excludedHistorical ? ["Ein Teil möglicher historischer Ereignisse wurde wegen fehlender Provenienz oder aktueller Sichtbarkeit nicht berücksichtigt."] : []), ...(occurrenceRows.some((r) => !visibleOccurrenceIds.has(r.id)) ? ["Einige Wiederholungsvorkommen haben keinen sichtbaren Aktivitätsnachweis und wurden ausgelassen."] : [])] } } };
  return { ...base, markdown: renderMarkdown(base) };
}
