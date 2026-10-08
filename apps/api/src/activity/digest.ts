import type {
  ActivityDigest,
  ActivityDigestEntry,
  ActivityDigestParams,
  ActivityEventMetadata,
  ActivityStateSnapshot,
  ActivityActor,
} from "@machbar/shared";
import { and, asc, eq, gt, lte, max, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";

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
    projectId: row.projectId,
    taskKind: row.taskKind ?? undefined,
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

function isOpen(snapshot: ActivityStateSnapshot | null): boolean {
  return (
    snapshot?.status !== "done" &&
    snapshot?.status !== "cancelled" &&
    snapshot?.status !== "completed" &&
    snapshot?.status !== "archived"
  );
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
  } = {},
): ActivityDigestEntry {
  const last = latest(events);
  return {
    key,
    category,
    priority,
    kind,
    params: params(values.params),
    actor: actorFor(events),
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
  const before = events.find((event) => event.metadata.before)?.metadata.before;
  const after =
    [...events].reverse().find((event) => event.metadata.after)?.metadata.after ??
    currentSnapshot(row);
  const entries: ActivityDigestEntry[] = [];

  if (
    last.entityType === "project" &&
    last.kind === "project_created" &&
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
    last.metadata.nextStatus === "active"
  ) {
    entries.push(
      makeEntry(`project-active:${itemId}`, "milestone", 2, "project_reopened", events, {
        project,
        params: params({ title: last.entityTitle }),
      }),
    );
  }

  const unblockedIndex =
    last.metadata.relatedTaskIds?.findIndex(
      (_taskId, index) =>
        last.metadata.relatedTaskOwnerIds?.[index] === viewerMemberId,
    ) ?? -1;
  if (unblockedIndex >= 0) {
    const unblockedId = last.metadata.relatedTaskIds![unblockedIndex]!;
    const unblockedTitle =
      last.metadata.relatedTaskTitles?.[unblockedIndex] ??
      rows.get(unblockedId)?.title ??
      "task";
    entries.push(
      makeEntry(`executable:${unblockedId}`, "personal", 1, "task_executable", events, {
        project,
        primary: {
          type: "task",
          id: unblockedId,
          title: unblockedTitle,
        },
        params: params({ title: unblockedTitle }),
      }),
    );
  }

  if (events.some((event) => event.kind === "task_created") && !hasNetCompletion(events)) {
    const assigned = after?.effectiveOwnerId === viewerMemberId;
    if (assigned && !entries.some((entry) => entry.kind === "task_executable")) {
      entries.push(
        makeEntry("assignment:" + itemId, "personal", 1, "task_assigned", events, {
          project,
          params: params({ title: last.entityTitle }),
        }),
      );
    } else if (
      (projectRow === undefined || projectRow.status === "active") &&
      eventScope(last) !== "work" &&
      isOpen(after)
    ) {
      entries.push(
        makeEntry("new:" + itemId, "new_work", 5, "new_work", events, {
          project,
          params: params({ title: last.entityTitle }),
        }),
      );
    }
  }

  const assignmentChanged =
    before !== undefined &&
    after !== null &&
    ((before.effectiveOwnerId !== undefined &&
      after.effectiveOwnerId !== undefined &&
      before.effectiveOwnerId !== after.effectiveOwnerId) ||
      (before.ownerMemberId !== undefined &&
        after.ownerMemberId !== undefined &&
        before.ownerMemberId !== after.ownerMemberId));
  if (assignmentChanged && isOpen(after)) {
    const afterOwner = after.effectiveOwnerId ?? after.ownerMemberId;
    const beforeOwner = before?.effectiveOwnerId ?? before?.ownerMemberId;
    if (afterOwner === viewerMemberId) {
      entries.push(
        makeEntry("assignment:" + itemId, "personal", 1, "task_assigned", events, {
          project,
          params: params({ title: last.entityTitle }),
        }),
      );
    } else if (beforeOwner === viewerMemberId) {
      entries.push(
        makeEntry("unassignment:" + itemId, "personal", 1, "task_unassigned", events, {
          project,
          params: params({ title: last.entityTitle }),
        }),
      );
    }
  }

  if (last.entityType === "task" && hasNetCompletion(events) && !events.some((event) => event.metadata.recurrenceOccurrenceId)) {
    const completionEvents = events.filter(
      (event) =>
        event.kind === "task_status_changed" &&
        event.metadata.nextStatus === "done",
    );
    if (completionEvents.some((event) => event.actor?.id !== viewerMemberId)) {
      entries.push(
        makeEntry("completion:" + itemId, "progress", 3, "task_completed", events, {
          project,
          params: params({ title: last.entityTitle }),
        }),
      );
    }
  }

  if (last.entityType === "project" && hasNetCompletion(events)) {
    const completionEvents = events.filter(
      (event) =>
        event.kind === "project_status_changed" &&
        event.metadata.nextStatus === "completed",
    );
    if (completionEvents.some((event) => event.actor?.id !== viewerMemberId)) {
      entries.push(
        makeEntry("project-completed:" + itemId, "milestone", 2, "project_completed", completionEvents, {
          project,
          params: params({ title: last.entityTitle }),
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
    entries.push(
      makeEntry("task-reopened:" + itemId, after?.effectiveOwnerId === viewerMemberId ? "personal" : "plan", after?.effectiveOwnerId === viewerMemberId ? 1 : 4, "task_executable", events, {
        project,
        params: params({ title: last.entityTitle }),
      }),
    );
  }

  if (
    last.entityType === "project" &&
    events.some(
      (event) =>
        event.kind === "project_status_changed" &&
        event.metadata.previousStatus === "completed" &&
        event.metadata.nextStatus === "active",
    )
  ) {
    entries.push(
      makeEntry("project-reopened:" + itemId, "milestone", 2, "project_reopened", events, {
        project,
        params: params({ title: last.entityTitle }),
      }),
    );
  }

  const meaningfulPlanChange = events.some((event) => {
    if (event.kind !== "task_updated" && event.kind !== "project_updated") return false;
    const changed = event.metadata.changedFields ?? [];
    return changed.some((field) =>
      ["ownerMemberId", "effectiveOwnerId", "dueDate", "scheduledDate", "notBeforeAt", "notBeforeDate"].includes(field),
    );
  });
  if (
    meaningfulPlanChange &&
    events.some((event) => event.actor?.id !== viewerMemberId) &&
    !entries.some((entry) => entry.kind === "task_assigned")
  ) {
    entries.push(
      makeEntry("plan:" + itemId, "plan", 4, "plan_changed", events, {
        project,
        params: params({
          title: last.entityTitle,
          previousDate: before?.dueDate ?? before?.scheduledDate ?? null,
          date: after?.dueDate ?? after?.scheduledDate ?? null,
        }),
      }),
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
  if (last.kind === "task_external_wait_resolved" && after?.effectiveOwnerId === viewerMemberId) {
    entries.push(
      makeEntry("wait-resolved:" + itemId, "personal", 1, "wait_resolved", events, {
        project,
        params: params({ title: last.entityTitle }),
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
  const completedProjects = new Set(
    entries
      .filter((entry) => entry.kind === "project_completed")
      .map((entry) => entry.project?.id ?? entry.primary?.id)
      .filter((id): id is number => id !== null && id !== undefined),
  );
  const projectProgress = new Map<string, ActivityDigestEntry[]>();
  const standalone: ActivityDigestEntry[] = [];
  for (const entry of entries) {
    if (
      (entry.kind === "task_completed" || entry.kind === "project_progress") &&
      entry.project?.id !== null &&
      entry.project?.id !== undefined &&
      completedProjects.has(entry.project.id)
    ) {
      continue;
    }
    if (entry.kind === "task_completed" && entry.project?.id !== null && entry.project?.id !== undefined) {
      const key = String(entry.project.id);
      const list = projectProgress.get(key) ?? [];
      list.push(entry);
      projectProgress.set(key, list);
    } else {
      standalone.push(entry);
    }
  }
  for (const [projectId, list] of projectProgress) {
    if (list.length === 1) {
      standalone.push(list[0]!);
      continue;
    }
    const first = list[0]!;
    const related = list.flatMap((entry) => [entry.primary, ...entry.related]).filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    const actorCounts = new Map<number | null, {
      actor: { id: number; name: string } | null;
      count: number;
    }>();
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
    standalone.push({
      ...first,
      key: `progress:${projectId}`,
      kind: "project_progress",
      params: params({
        count: list.length,
        titles: list.slice(0, 2).map((entry) => String(entry.params.title ?? "")),
        actorCounts: [...actorCounts.values()],
      }),
      primary: first.project,
      related,
      eventIds: list.flatMap((entry) => entry.eventIds),
      latestEventAt: list.map((entry) => entry.latestEventAt).sort().at(-1)!,
    });
  }
  return standalone.filter(
    (entry, index, all) => all.findIndex((candidate) => candidate.key === entry.key) === index,
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
  for (const row of raw) {
    const item: WorkItemRow = {
      ...row,
      role: row.role,
      scope: row.scope,
      projectId: row.role === "story" ? row.id : projectByTask.get(row.id) ?? null,
      taskKind: row.taskKind as "action" | "reference" | null,
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
    row?.ownerMemberId;
  return owner === viewerMemberId;
}

export function getActivityDigest(
  db: Db,
  viewerMemberId: number,
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
    const allEvents = loadEvents(txDb, acknowledgedThroughEventId, maximum);
    const visible = allEvents.filter((event) =>
      visibleToViewer(event, viewerMemberId, rows),
    );
    const hiddenEntryCount = allEvents.length - visible.length;
    const entries = aggregate(
      groupEvents(visible).flatMap((group) => classify(group, viewerMemberId, rows, projects)),
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
      hiddenEntryCount,
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
