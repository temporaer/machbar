import { and, eq, sql } from "drizzle-orm";
import type { TaskKind, TaskStatus, WorkItemScope } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";

type TaskRowInput = {
  parentId: number | null;
  title: string;
  status: TaskStatus;
  scope: WorkItemScope;
  taskKind?: TaskKind;
  notes?: string;
  ownerMemberId?: number | null;
  ownerInheritanceMode?: "inherit" | "explicit" | "none";
  physicalContextInheritanceMode?: "inherit" | "explicit" | "none";
  createdByMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  revisitAt?: string | null;
  notBeforeAt?: string | null;
  notBeforeDate?: string | null;
  priority?: number | null;
  size?: string | null;
  repeatAfterDays?: number | null;
  allowedDeviationDays?: number | null;
  additionalNextAction?: boolean;
  position?: number;
};

export function storedTaskStatus(status: TaskStatus): "captured" | "active" | "backlog" | "done" | "cancelled" {
  switch (status) {
    case "actionable": return "active";
    case "someday": return "backlog";
    case "captured":
    case "done":
    case "cancelled": return status;
  }
}

export function nextTaskPosition(db: Db, parentId: number | null): number {
  const rows = db.select({ position: schema.workItems.position })
    .from(schema.workItems)
    .where(and(
      eq(schema.workItems.role, "task"),
      parentId === null ? sql`${schema.workItems.parentId} IS NULL` : eq(schema.workItems.parentId, parentId),
    )).all();
  return rows.reduce((max, row) => Math.max(max, row.position), -1) + 1;
}

/** Shared canonical row defaults/positioning for normal task creation and transition-created next actions. */
export function insertTaskRow(db: Db, input: TaskRowInput) {
  const kind = input.taskKind ?? "action";
  const isRoot = input.parentId === null;
  const autoAssignedOwner = isRoot && input.scope === "work" && input.ownerMemberId === undefined
    ? input.createdByMemberId ?? null
    : null;
  const ownerMemberId = input.ownerMemberId ?? autoAssignedOwner;
  const row = db.insert(schema.workItems).values({
    role: "task",
    taskKind: kind,
    parentId: input.parentId,
    title: input.title.trim(),
    notes: input.notes ?? "",
    status: storedTaskStatus(input.status),
    needsClarification: input.status === "captured",
    ownerMemberId,
    ownerInheritanceMode: input.ownerInheritanceMode ?? (autoAssignedOwner !== null ? "explicit" : "inherit"),
    physicalContextInheritanceMode: input.physicalContextInheritanceMode ?? "inherit",
    createdByMemberId: input.createdByMemberId ?? null,
    scope: input.scope,
    dueDate: input.dueDate ?? null,
    scheduledDate: input.scheduledDate ?? null,
    revisitAt: input.revisitAt ?? null,
    notBeforeAt: input.notBeforeAt ?? null,
    notBeforeDate: input.notBeforeDate ?? null,
    priority: input.priority ?? null,
    size: input.size ?? null,
    repeatAfterDays: input.repeatAfterDays ?? null,
    allowedDeviationDays: input.allowedDeviationDays ?? null,
    additionalNextAction: input.additionalNextAction ?? false,
    position: input.position ?? nextTaskPosition(db, input.parentId),
  }).returning().get();
  return row;
}
