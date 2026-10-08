import type {
  ActivityDigest,
  ActivityDigestEntry,
  ActivityDigestParams,
  ActivityEventMetadata,
  ActivityStateSnapshot,
  ActivityActor,
  ActivityDigestActorCount,
} from "@machbar/shared";
import { and, asc, eq, gt, lte, max, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import { getEffectiveOwners } from "../repo/effectiveRepo.js";

interface DigestEvent {
  id: number;
  createdAt: string;
  kind: (typeof schema.activityEvents.kind.enumValues)[number];
  entityId: number | null;
  entityType: "task" | "project";
  entityTitle: string;
  metadata: ActivityEventMetadata;
  actor: ActivityActor | null;
}

interface WorkItemRow {
  id: number;
  role: "task" | "story";
  title: string;
  status: string;
  archivedAt: string | null;
  scope: "household" | "work";
  ownerMemberId: number | null;
  parentId: number | null;
  projectId: number | null;
  taskKind: "action" | "reference" | null;
  effectiveOwnerId: number | null;
  dueDate: string | null;
  scheduledDate: string | null;
  notBeforeAt: string | null;
  notBeforeDate: string | null;
}

function stableId(event: DigestEvent): number | null {
  return event.metadata.affectedWorkItemId ?? event.entityId;
}

function eventScope(event: DigestEvent): "household" | "work" | null {
  return event.metadata.scope ?? null;
}

function ref(
  event: DigestEvent,
  id: number | null = stableId(event),
): { type: "task" | "project"; id: number | null; title: string } {
  return { type: event.entityType, id, title: event.entityTitle };
}

function actorFor(events: DigestEvent[]): ActivityActor | null {
  return [...events].reverse().find((event) => event.actor !== null)?.actor ?? null;
}

function latest(events: DigestEvent[]): DigestEvent {
  return events.at(-1)!;
}

function params(
  values: ActivityDigestParams = {},
): ActivityDigestParams {
  return values;
}

function currentSnapshot(row: WorkItemRow | undefined): ActivityStateSnapshot | null {
  if (!row) return null;
  return {
    ownerMemberId: row.ownerMemberId,
    effectiveOwnerId: row.effectiveOwnerId,
    projectId: row.projectId,
    taskKind: row.taskKind ?? undefined,
    dueDate: row.dueDate,
    scheduledDate: row.scheduledDate,
    notBeforeAt: row.notBeforeAt,
    notBeforeDate: row.notBeforeDate,
    status:
      row.role === "task"
        ? row.status === "done"
          ? "done"
          : row.status === "cancelled"
            ? "cancelled"
            : row.status === "captured"
              ? "captured"
              : row.status === "active"
                ? "actionable"
                : "someday"
        : row.archivedAt !== null
          ? "archived"
          : row.status === "active"
            ? "active"
            : row.status === "done"
              ? "completed"
              : "backlog",
  };
}

function reduceSnapshot(
  events: DigestEvent[],
  direction: "before" | "after",
): ActivityStateSnapshot {
  const result: ActivityStateSnapshot = {};
  for (const event of events) {
    const snapshot = event.metadata[direction];
    if (!snapshot) continue;
    for (const [key, value] of Object.entries(snapshot) as Array<
      [keyof ActivityStateSnapshot, ActivityStateSnapshot[keyof ActivityStateSnapshot]]
    >) {
      if (direction === "before" && result[key] !== undefined) continue;
      if (value !== undefined) result[key] = value as never;
    }
  }
  return result;
}

function isOpen(snapshot: ActivityStateSnapshot | null): boolean {
  if (snapshot === null) return false;
  return (
    snapshot.status !== "done" &&
    snapshot.status !== "cancelled" &&
    snapshot.status !== "completed" &&
    snapshot.status !== "archived"
  );
}

function effectiveOwner(snapshot: ActivityStateSnapshot | undefined | null): number | null | undefined {
  if (!snapshot) return undefined;
  return snapshot.effectiveOwnerId !== undefined
    ? snapshot.effectiveOwnerId
    : snapshot.ownerMemberId;
}

function ownershipTransition(event: DigestEvent): {
  before: number | null | undefined;
  after: number | null | undefined;
} | null {
  if (
    event.kind !== "task_updated" &&
    event.kind !== "project_updated" &&
    event.kind !== "task_created"
  ) {
    return null;
  }
  const before = effectiveOwner(event.metadata.before);
  const after = effectiveOwner(event.metadata.after);
  if (before === undefined || after === undefined || before === after) return null;
  return { before, after };
}

function finalEvent(
  events: DigestEvent[],
  predicate: (event: DigestEvent) => boolean,
): DigestEvent | undefined {
  return [...events].reverse().find(predicate);
}

function finalStatus(events: DigestEvent[]): string | undefined {
  return finalEvent(events, (event) => event.metadata.nextStatus !== undefined)
    ?.metadata.nextStatus;
}

function todayInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
}

function daysFromToday(value: string | null | undefined, timezone: string): number | null {
  if (!value) return null;
  const today = todayInTimezone(timezone);
  const date = Date.parse(`${value}T00:00:00Z`);
  const start = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(date) || Number.isNaN(start)) return null;
  return Math.round((date - start) / 86_400_000);
}

function relevantDateChange(
  before: ActivityStateSnapshot | undefined,
  after: ActivityStateSnapshot | null,
  fields: string[],
  timezone: string,
): {
  field: string;
  priority: 1 | 4;
  dateType: "deadline" | "scheduled" | "availability";
  previousDate: string | null;
  date: string | null;
  direction: "earlier" | "later" | "new" | "removed";
} | null {
  if (!after) return null;
  const candidates: Array<{
    field: string;
    dateType: "deadline" | "scheduled" | "availability";
    previousDate: string | null;
    date: string | null;
    horizon: number;
  }> = [
    {
      field: "dueDate",
      dateType: "deadline",
      previousDate: before?.dueDate ?? null,
      date: after.dueDate ?? null,
      horizon: 14,
    },
    {
      field: "scheduledDate",
      dateType: "scheduled",
      previousDate: before?.scheduledDate ?? null,
      date: after.scheduledDate ?? null,
      horizon: 7,
    },
    {
      field: "notBeforeDate",
      dateType: "availability",
      previousDate: before?.notBeforeDate ?? null,
      date: after.notBeforeDate ?? null,
      horizon: 0,
    },
  ];
  for (const candidate of candidates) {
    if (!fields.includes(candidate.field) && !fields.includes("notBeforeAt")) continue;
    if (candidate.previousDate === candidate.date) continue;
    if (candidate.date === null && candidate.dateType !== "deadline") continue;
    const previousDistance = daysFromToday(candidate.previousDate, timezone);
    const distance = daysFromToday(candidate.date, timezone);
    const direction =
      candidate.previousDate === null
        ? "new"
        : candidate.date === null
          ? "removed"
          : distance !== null && previousDistance !== null && distance < previousDistance
            ? "earlier"
            : "later";
    const imminent =
      (distance !== null && distance <= candidate.horizon) ||
      (previousDistance !== null && previousDistance <= candidate.horizon);
    if (candidate.dateType === "availability") {
      if (after.executable !== true) continue;
      return { ...candidate, priority: 1, direction };
    }
    if (imminent) {
      return {
        ...candidate,
        priority: candidate.dateType === "deadline" && direction !== "later" ? 1 : 4,
        direction,
      };
    }
  }
  return null;
}

function isDeleted(events: DigestEvent[]): boolean {
  const last = latest(events);
  return last.kind === "task_deleted" || last.kind === "project_deleted";
}

function hasNetCompletion(events: DigestEvent[]): boolean {
  let completed = false;
  for (const event of events) {
    if (
      (event.kind === "task_status_changed" ||
        event.kind === "project_status_changed") &&
      event.metadata.nextStatus !== undefined
    ) {
      if (event.metadata.nextStatus === "done" || event.metadata.nextStatus === "completed") {
        completed = true;
      }
      if (
        event.metadata.nextStatus === "actionable" ||
        event.metadata.nextStatus === "captured" ||
        event.metadata.nextStatus === "someday" ||
        event.metadata.nextStatus === "active" ||
        event.metadata.nextStatus === "backlog"
      ) {
        completed = false;
      }
    }
  }
  return completed;
}

function makeEntry(
  key: string,
  category: ActivityDigestEntry["category"],
  priority: ActivityDigestEntry["priority"],
  kind: ActivityDigestEntry["kind"],
  events: DigestEvent[],
  values: {
    params?: ActivityDigestParams;
    project?: ActivityDigestEntry["project"];
    primary?: ActivityDigestEntry["primary"];
    related?: ActivityDigestEntry["related"];
    actor?: ActivityActor | null;
  } = {},
): ActivityDigestEntry {
  const last = latest(events);
  return {
    key,
    category,
    priority,
    kind,
    params: params(values.params),
    actor: values.actor === undefined ? actorFor(events) : values.actor,
    project: values.project ?? null,
    primary: values.primary ?? ref(last),
    related: values.related ?? [],
    eventIds: events.map((event) => event.id),
    latestEventAt: last.createdAt,
  };
}

function classify(
  events: DigestEvent[],
  viewerMemberId: number,
  rows: Map<number, WorkItemRow>,
  projects: Map<number, WorkItemRow>,
  graph: Graph,
  timezone: string,
): ActivityDigestEntry[] {
  const last = latest(events);
  const itemId = stableId(last);
  const row = itemId === null ? undefined : rows.get(itemId);
  const projectId =
    last.metadata.projectContextId ??
    (row?.role === "task" ? row.projectId : row?.role === "story" ? row.id : null);
  const projectRow = projectId === null ? undefined : projects.get(projectId);
  const project =
    projectId !== null && projectRow
      ? { type: "project" as const, id: projectId, title: projectRow.title }
      : null;
  const before = reduceSnapshot(events, "before");
  const after =
    {
      ...currentSnapshot(row),
      ...reduceSnapshot(events, "after"),
    };
  const entries: ActivityDigestEntry[] = [];
  if (isDeleted(events)) return entries;

  if (
    last.entityType === "project" &&
    last.kind === "project_created" &&
    last.actor?.id !== viewerMemberId &&
    projectRow?.status === "active" &&
    isOpen(after)
  ) {
    entries.push(
      makeEntry(`new-project:${itemId}`, "new_work", 5, "new_work", events, {
        primary: ref(last),
        params: params({ title: last.entityTitle }),
      }),
    );
  }

  if (
    last.entityType === "project" &&
    last.kind === "project_status_changed" &&
    last.metadata.previousStatus === "backlog" &&
    last.metadata.nextStatus === "active" &&
    last.actor?.id !== viewerMemberId
  ) {
    entries.push(
      makeEntry(`project-active:${itemId}`, "milestone", 2, "project_activated", events, {
        project,
        params: params({ title: last.entityTitle }),
      }),
    );
  }

  const waitResolvedEvent = finalEvent(
    events,
    (event) => event.kind === "task_external_wait_resolved",
  );
  const unlockCandidates = new Map<number, DigestEvent>();
  for (const event of events) {
    for (const taskId of event.metadata.newlyExecutableTaskIds ?? []) {
      unlockCandidates.set(taskId, event);
    }
  }
  for (const [unblockedId, unlockEvent] of unlockCandidates) {
    if (unlockEvent.kind === "task_external_wait_resolved") continue;
    const task = graph.tasksById.get(unblockedId);
    if (
      task === undefined ||
      unlockEvent.actor?.id === viewerMemberId ||
      !task.executable ||
      task.status === "done" ||
      task.status === "cancelled" ||
      task.kind !== "action" ||
      task.effectiveOwnerId !== viewerMemberId
    ) {
      continue;
    }
    const unblockedTitle = task.title;
    const affectedProject =
      task.projectId === null ? null : projects.get(task.projectId);
    entries.push(
      makeEntry(`executable:${unblockedId}`, "personal", 1, "task_executable", [unlockEvent], {
        project: affectedProject
          ? { type: "project", id: affectedProject.id, title: affectedProject.title }
          : null,
        primary: { type: "task", id: unblockedId, title: unblockedTitle },
        params: params({ title: unblockedTitle }),
        actor: unlockEvent.actor,
      }),
    );
  }

  const createdEvent = finalEvent(events, (event) => event.kind === "task_created");
  const ownershipEvents = events
    .map((event) => {
      const transition = ownershipTransition(event);
      return transition ? { event, ...transition } : null;
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const initialOwner =
    effectiveOwner(events.find((event) => event.metadata.before)?.metadata.before) ??
    effectiveOwner(createdEvent?.metadata.after);
  const finalOwner = effectiveOwner(after);
  const assignmentToViewer = [...ownershipEvents]
    .reverse()
    .find(
      (value) =>
        value.before !== viewerMemberId &&
        value.after === viewerMemberId &&
        value.event.actor?.id !== viewerMemberId,
    );
  const assignmentAwayFromViewer = [...ownershipEvents]
    .reverse()
    .find(
      (value) =>
        value.before === viewerMemberId &&
        value.after !== viewerMemberId &&
        value.event.actor?.id !== viewerMemberId,
    );
  if (
    createdEvent !== undefined &&
    createdEvent.actor?.id !== viewerMemberId &&
    !hasNetCompletion(events)
  ) {
    const createdAssignedToViewer =
      effectiveOwner(createdEvent.metadata.after) === viewerMemberId &&
      assignmentToViewer === undefined &&
      ownershipEvents.length === 0 &&
      finalOwner === viewerMemberId;
    if (createdAssignedToViewer) {
      entries.push(
        makeEntry("assignment:" + itemId, "personal", 1, "task_assigned", [createdEvent], {
          project,
          params: params({ title: last.entityTitle }),
          actor: createdEvent.actor,
        }),
      );
    } else if (
      (projectRow === undefined || projectRow.status === "active") &&
      eventScope(last) !== "work" &&
      finalOwner !== viewerMemberId &&
      isOpen(after)
    ) {
      entries.push(
        makeEntry("new:" + itemId, "new_work", 5, "new_work", [createdEvent], {
          project,
          params: params({ title: last.entityTitle }),
          actor: createdEvent.actor,
        }),
      );
    }
  }

  if (
    assignmentToViewer !== undefined &&
    initialOwner !== viewerMemberId &&
    finalOwner === viewerMemberId &&
    isOpen(after)
  ) {
    entries.push(
      makeEntry("assignment:" + itemId, "personal", 1, "task_assigned", [assignmentToViewer.event], {
        project,
        params: params({ title: last.entityTitle }),
        actor: assignmentToViewer.event.actor,
      }),
    );
  }
  if (
    assignmentToViewer === undefined &&
    assignmentAwayFromViewer !== undefined &&
    initialOwner === viewerMemberId &&
    finalOwner !== viewerMemberId &&
    isOpen(after)
  ) {
    entries.push(
      makeEntry(
        "unassignment:" + itemId,
        "personal",
        1,
        "task_unassigned",
        [assignmentAwayFromViewer.event],
        {
          project,
          params: params({ title: last.entityTitle }),
          actor: assignmentAwayFromViewer.event.actor,
        },
      ),
    );
  }

  if (last.entityType === "task" && hasNetCompletion(events) && !events.some((event) => event.metadata.recurrenceOccurrenceId)) {
    const completionEvents = events.filter(
      (event) =>
        event.kind === "task_status_changed" &&
        event.metadata.nextStatus === "done",
    );
    const completion = completionEvents.at(-1);
    if (completion !== undefined && completion.actor?.id !== viewerMemberId) {
      entries.push(
        makeEntry("completion:" + itemId, "progress", 3, "task_completed", events, {
          project,
          params: params({ title: last.entityTitle }),
          actor: completion.actor,
        }),
      );
    }
  }

  if (last.entityType === "project" && finalStatus(events) === "completed") {
    const completionEvents = events.filter(
      (event) =>
        event.kind === "project_status_changed" &&
        event.metadata.nextStatus === "completed",
    );
    const completion = completionEvents.at(-1);
    if (completion !== undefined && completion.actor?.id !== viewerMemberId) {
      entries.push(
        makeEntry("project-completed:" + itemId, "milestone", 2, "project_completed", events, {
          project,
          params: params({ title: last.entityTitle }),
          actor: completion.actor,
        }),
      );
    }
  }

  if (
    last.entityType === "task" &&
    events.some(
      (event) =>
        event.kind === "task_status_changed" &&
        event.metadata.previousStatus === "done" &&
        event.metadata.nextStatus === "actionable",
    ) &&
    !hasNetCompletion(events) &&
    events.some(
      (event) =>
        event.kind === "task_status_changed" &&
        event.metadata.previousStatus === "done" &&
        event.metadata.nextStatus === "actionable" &&
        event.actor?.id !== viewerMemberId,
    )
  ) {
    const task = itemId === null ? undefined : graph.tasksById.get(itemId);
    const reopening = finalEvent(events, (event) =>
      event.kind === "task_status_changed" &&
      event.metadata.previousStatus === "done" &&
      event.metadata.nextStatus === "actionable",
    );
    if (
      task?.executable &&
      task.effectiveOwnerId === viewerMemberId &&
      reopening !== undefined &&
      reopening.actor?.id !== viewerMemberId
    ) {
      entries.push(
        makeEntry("task-reopened:" + itemId, "personal", 1, "task_executable", [reopening], {
          project,
          params: params({ title: last.entityTitle }),
          actor: reopening.actor,
        }),
      );
    }
  }

  if (
    last.entityType === "project" &&
    finalStatus(events) === "active" &&
    events.some(
      (event) =>
        event.kind === "project_status_changed" &&
        event.metadata.previousStatus === "completed" &&
        event.metadata.nextStatus === "active",
    )
  ) {
    const reopening = finalEvent(events, (event) =>
      event.kind === "project_status_changed" &&
      event.metadata.previousStatus === "completed" &&
      event.metadata.nextStatus === "active",
    );
    entries.push(
      makeEntry("project-reopened:" + itemId, "milestone", 2, "project_reopened", [reopening!], {
        project,
        params: params({ title: last.entityTitle }),
        actor: reopening?.actor,
      }),
    );
  }

  const relevantDateFields = [
    "dueDate",
    "scheduledDate",
    "notBeforeAt",
    "notBeforeDate",
    "externalWait",
    "revisitDate",
  ];
  const dateEvents = new Map<string, DigestEvent>();
  for (const event of events) {
    if (
      (event.kind !== "task_updated" && event.kind !== "project_updated") ||
      event.actor?.id === viewerMemberId
    ) {
      continue;
    }
    for (const field of event.metadata.changedFields ?? []) {
      if (relevantDateFields.includes(field)) dateEvents.set(field, event);
    }
  }
  const changedDateFields = [
    ...new Set(
      events.flatMap((event) =>
        event.actor?.id !== viewerMemberId
          ? event.metadata.changedFields ?? []
          : [],
      ),
    ),
  ];
  const planChange =
    dateEvents.size === 0
      ? null
      : relevantDateChange(
          before,
          after,
          changedDateFields,
          timezone,
        );
  if (planChange !== null && !entries.some((entry) => entry.kind === "task_assigned")) {
    const personal =
      last.entityType === "task" &&
      effectiveOwner(after) === viewerMemberId;
    const priority =
      planChange.priority === 1 && !personal ? 4 : planChange.priority;
    entries.push(
      makeEntry(
        "plan:" + itemId,
        priority === 1 ? "personal" : "plan",
        priority,
        "plan_changed",
        events,
        {
        project,
        params: params({
          title: last.entityTitle,
          previousDate: planChange.previousDate,
          date: planChange.date,
          dateType: planChange.dateType,
          direction: planChange.direction,
        }),
        actor: dateEvents.get(planChange.field)?.actor ?? null,
        },
      ),
    );
  }

  if (
    (last.kind === "task_external_wait_started" ||
      (last.kind === "task_external_wait_updated" &&
        last.metadata.changedFields?.some((field) =>
          ["externalWait", "revisitDate"].includes(field),
        ))) &&
    events.some((event) => event.actor?.id !== viewerMemberId)
  ) {
    entries.push(
      makeEntry("wait:" + itemId, "plan", 4, "wait_started", events, {
        project,
        params: params({ title: last.entityTitle }),
      }),
    );
  }
  if (
    waitResolvedEvent !== undefined &&
    waitResolvedEvent.actor?.id !== viewerMemberId &&
    itemId !== null &&
    graph.tasksById.get(itemId)?.executable === true &&
    graph.tasksById.get(itemId)?.effectiveOwnerId === viewerMemberId
  ) {
    entries.push(
      makeEntry("wait-resolved:" + itemId, "personal", 1, "wait_resolved", [waitResolvedEvent], {
        project,
        params: params({ title: last.entityTitle }),
        actor: waitResolvedEvent.actor,
      }),
    );
  }

  return entries;
}

function groupEvents(events: DigestEvent[]): DigestEvent[][] {
  const groups = new Map<string, DigestEvent[]>();
  for (const event of events) {
    const id = stableId(event);
    const key = `${event.entityType}:${id ?? `event-${event.id}`}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a[0]!.id - b[0]!.id);
}

function aggregate(entries: ActivityDigestEntry[]): ActivityDigestEntry[] {
  const completedProjects = new Set<number>();
  const completionSupport = new Map<number, ActivityDigestEntry[]>();
  const assignments = new Map<number, ActivityDigestEntry[]>();
  const otherEntries: ActivityDigestEntry[] = [];

  for (const entry of entries) {
    const projectId = entry.project?.id;
    if (entry.kind === "project_completed" && typeof projectId === "number") {
      completedProjects.add(projectId);
      continue;
    }
    if (entry.kind === "task_completed" && typeof projectId === "number") {
      const list = completionSupport.get(projectId) ?? [];
      list.push(entry);
      completionSupport.set(projectId, list);
      continue;
    }
    if (entry.kind === "task_assigned" && typeof projectId === "number") {
      const list = assignments.get(projectId) ?? [];
      list.push(entry);
      assignments.set(projectId, list);
      continue;
    }
    otherEntries.push(entry);
  }

  const result: ActivityDigestEntry[] = [...otherEntries];
  for (const entry of entries) {
    if (entry.kind !== "project_completed") continue;
    const projectId = entry.project?.id;
    const support = typeof projectId === "number"
      ? completionSupport.get(projectId) ?? []
      : [];
    const actorCounts = new Map<number | null, ActivityDigestActorCount>();
    for (const taskEntry of support) {
      const actorId = taskEntry.actor?.id ?? null;
      const current = actorCounts.get(actorId) ?? {
        actor: taskEntry.actor
          ? { id: taskEntry.actor.id, name: taskEntry.actor.name }
          : null,
        count: 0,
      };
      current.count += 1;
      actorCounts.set(actorId, current);
    }
    result.push({
      ...entry,
      params: params({
        ...entry.params,
        ...(support.length > 0
          ? {
              completionCount: support.length,
              titles: support.slice(0, 2).map((value) =>
                String(value.params.title ?? ""),
              ),
              actorCounts: [...actorCounts.values()],
            }
          : {}),
      }),
      related: [
        ...entry.related,
        ...support.flatMap((value) => [
          ...(value.primary ? [value.primary] : []),
          ...value.related,
        ]),
      ],
    });
  }

  for (const [projectId, list] of completionSupport) {
    if (completedProjects.has(projectId)) continue;
    if (list.length === 1) {
      result.push(list[0]!);
      continue;
    }
    const first = list[0]!;
    const actorCounts = new Map<number | null, ActivityDigestActorCount>();
    for (const entry of list) {
      const actorId = entry.actor?.id ?? null;
      const current = actorCounts.get(actorId) ?? {
        actor: entry.actor
          ? { id: entry.actor.id, name: entry.actor.name }
          : null,
        count: 0,
      };
      current.count += 1;
      actorCounts.set(actorId, current);
    }
    result.push({
      ...first,
      key: `progress:${projectId}`,
      kind: "project_progress",
      params: params({
        count: list.length,
        titles: list.slice(0, 2).map((entry) => String(entry.params.title ?? "")),
        actorCounts: [...actorCounts.values()],
      }),
      primary: first.project,
      related: list.flatMap((entry) => [
        ...(entry.primary ? [entry.primary] : []),
        ...entry.related,
      ]),
      eventIds: list.flatMap((entry) => entry.eventIds),
      latestEventAt: list.map((entry) => entry.latestEventAt).sort().at(-1)!,
    });
  }

  for (const [projectId, list] of assignments) {
    if (list.length === 1) {
      result.push(list[0]!);
      continue;
    }
    const first = list[0]!;
    result.push({
      ...first,
      key: `assignment:${projectId}`,
      kind: "project_assignment",
      params: params({
        count: list.length,
        titles: list.slice(0, 2).map((entry) => String(entry.params.title ?? "")),
      }),
      primary: first.project,
      related: list.flatMap((entry) => [
        ...(entry.primary ? [entry.primary] : []),
        ...entry.related,
      ]),
      eventIds: list.flatMap((entry) => entry.eventIds),
      latestEventAt: list.map((entry) => entry.latestEventAt).sort().at(-1)!,
    });
  }

  return result.filter(
    (entry, index, all) =>
      all.findIndex((candidate) => candidate.key === entry.key) === index,
  );
}

function loadEvents(db: Db, fromId: number, throughId: number): DigestEvent[] {
  const rows = db
    .select({
      id: schema.activityEvents.id,
      createdAt: schema.activityEvents.createdAt,
      kind: schema.activityEvents.kind,
      entityId: schema.activityEvents.entityId,
      entityType: schema.activityEvents.entityType,
      entityTitle: schema.activityEvents.entityTitle,
      metadata: schema.activityEvents.metadata,
      actorId: schema.members.id,
      actorName: schema.members.name,
      actorColor: schema.members.color,
      actorPictureUrl: schema.memberOidcIdentities.pictureUrl,
    })
    .from(schema.activityEvents)
    .leftJoin(schema.members, eq(schema.activityEvents.actorMemberId, schema.members.id))
    .leftJoin(schema.memberOidcIdentities, eq(schema.members.id, schema.memberOidcIdentities.memberId))
    .where(
      and(
        gt(schema.activityEvents.id, fromId),
        lte(schema.activityEvents.id, throughId),
      ),
    )
    .orderBy(asc(schema.activityEvents.id))
    .all();
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    kind: row.kind,
    entityId: row.entityId,
    entityType: row.entityType,
    entityTitle: row.entityTitle,
    metadata: row.metadata as ActivityEventMetadata,
    actor:
      row.actorId === null || row.actorName === null || row.actorColor === null
        ? null
        : {
            id: row.actorId,
            name: row.actorName,
            color: row.actorColor,
            pictureUrl: row.actorPictureUrl ?? null,
          },
  }));
}

function loadWorkItems(db: Db): { rows: Map<number, WorkItemRow>; projects: Map<number, WorkItemRow> } {
  const raw = db
    .select({
      id: schema.workItems.id,
      role: schema.workItems.role,
      title: schema.workItems.title,
      status: schema.workItems.status,
      archivedAt: schema.workItems.archivedAt,
      scope: schema.workItems.scope,
      ownerMemberId: schema.workItems.ownerMemberId,
      parentId: schema.workItems.parentId,
      taskKind: schema.workItems.taskKind,
      dueDate: schema.workItems.dueDate,
      scheduledDate: schema.workItems.scheduledDate,
      notBeforeAt: schema.workItems.notBeforeAt,
      notBeforeDate: schema.workItems.notBeforeDate,
    })
    .from(schema.workItems)
    .all();
  const projectByTask = new Map<number, number>();
  for (const row of raw) {
    if (row.role === "story") continue;
    let parentId = row.parentId;
    while (parentId !== null) {
      const parent = raw.find((candidate) => candidate.id === parentId);
      if (!parent) break;
      if (parent.role === "story") {
        projectByTask.set(row.id, parent.id);
        break;
      }
      parentId = parent.parentId;
    }
  }
  const rows = new Map<number, WorkItemRow>();
  const projects = new Map<number, WorkItemRow>();
  const effectiveOwners = getEffectiveOwners(db);
  for (const row of raw) {
    const item: WorkItemRow = {
      ...row,
      role: row.role,
      scope: row.scope,
      projectId: row.role === "story" ? row.id : projectByTask.get(row.id) ?? null,
      taskKind: row.taskKind as "action" | "reference" | null,
      effectiveOwnerId:
        row.role === "task"
          ? effectiveOwners.get(row.id)?.ownerId ?? null
          : row.ownerMemberId,
    };
    rows.set(item.id, item);
    if (item.role === "story") projects.set(item.id, item);
  }
  return { rows, projects };
}

function visibleToViewer(
  event: DigestEvent,
  viewerMemberId: number,
  rows: Map<number, WorkItemRow>,
): boolean {
  const row = stableId(event) === null ? undefined : rows.get(stableId(event)!);
  const scope = eventScope(event) ?? row?.scope ?? null;
  if (scope === null) return false;
  if (scope !== "work") return true;
  const after = event.metadata.after;
  const before = event.metadata.before;
  const owner =
    after?.effectiveOwnerId ??
    before?.effectiveOwnerId ??
    row?.effectiveOwnerId;
  return owner === viewerMemberId;
}

export function getActivityDigest(
  db: Db,
  viewerMemberId: number,
  timezone = "UTC",
): ActivityDigest {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const maximum = txDb
      .select({ id: max(schema.activityEvents.id) })
      .from(schema.activityEvents)
      .get()?.id ?? 0;
    let state = txDb
      .select()
      .from(schema.memberActivityDigestState)
      .where(eq(schema.memberActivityDigestState.memberId, viewerMemberId))
      .get();
    if (!state) {
      txDb.insert(schema.memberActivityDigestState).values({
        memberId: viewerMemberId,
        acknowledgedThroughEventId: maximum,
      }).onConflictDoNothing().run();
      state = txDb
        .select()
        .from(schema.memberActivityDigestState)
        .where(eq(schema.memberActivityDigestState.memberId, viewerMemberId))
        .get();
    }
    const acknowledgedThroughEventId = state?.acknowledgedThroughEventId ?? maximum;
    if (acknowledgedThroughEventId >= maximum) {
      return {
        acknowledgedThroughEventId,
        throughEventId: maximum,
        entries: [],
        totalEntryCount: 0,
        hiddenEntryCount: 0,
      };
    }
    const { rows, projects } = loadWorkItems(txDb);
    const graph = Graph.load(txDb);
    const allEvents = loadEvents(txDb, acknowledgedThroughEventId, maximum);
    const visible = allEvents.filter((event) =>
      visibleToViewer(event, viewerMemberId, rows),
    );
    const entries = aggregate(
      groupEvents(visible).flatMap((group) =>
        classify(group, viewerMemberId, rows, projects, graph, timezone),
      ),
    ).sort(
      (a, b) =>
        a.priority - b.priority ||
        b.latestEventAt.localeCompare(a.latestEventAt) ||
        a.key.localeCompare(b.key),
    );
    return {
      acknowledgedThroughEventId,
      throughEventId: maximum,
      entries,
      totalEntryCount: entries.length,
      hiddenEntryCount: 0,
    };
  });
}

export function acknowledgeActivityDigest(
  db: Db,
  viewerMemberId: number,
  throughEventId: number,
): void {
  const maximum = db
    .select({ id: max(schema.activityEvents.id) })
    .from(schema.activityEvents)
    .get()?.id ?? 0;
  if (throughEventId < 0 || throughEventId > maximum) {
    throw AppError.badRequest(
      "activity_digest_ack_invalid",
      "The digest acknowledgement boundary is invalid.",
      { throughEventId, maximum },
    );
  }
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    txDb.insert(schema.memberActivityDigestState).values({
      memberId: viewerMemberId,
      acknowledgedThroughEventId: throughEventId,
    }).onConflictDoNothing().run();
    txDb.update(schema.memberActivityDigestState)
      .set({
        acknowledgedThroughEventId: sql`max(${schema.memberActivityDigestState.acknowledgedThroughEventId}, ${throughEventId})`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.memberActivityDigestState.memberId, viewerMemberId))
      .run();
  });
}
