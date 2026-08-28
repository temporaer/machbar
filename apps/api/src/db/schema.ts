import { sql } from "drizzle-orm";
import type {
  ActivityEntityType,
  ActivityEventKind,
  ActivityEventMetadata,
  ContributionCategory,
  ContributionReason,
} from "@machbar/shared";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

const activityEventKinds = [
  "task_created",
  "task_updated",
  "task_deleted",
  "task_status_changed",
  "task_descendants_status_changed",
  "task_moved",
  "task_dependencies_changed",
  "task_tags_changed",
  "project_created",
  "project_updated",
  "project_deleted",
  "project_status_changed",
  "project_tags_changed",
  "project_acceptance_criterion_added",
  "project_acceptance_criterion_updated",
  "project_acceptance_criterion_checked",
  "project_acceptance_criterion_removed",
] as const satisfies readonly ActivityEventKind[];

const activityEntityTypes = [
  "task",
  "project",
] as const satisfies readonly ActivityEntityType[];

const contributionCategories = [
  "completion",
  "planning",
] as const satisfies readonly ContributionCategory[];

const contributionReasons = [
  "task_completed",
  "project_completed",
  "task_clarified",
  "task_assigned",
  "task_estimated",
  "task_planned",
  "waiting_followup_added",
  "task_broken_down",
  "project_outcome_added",
  "project_driver_assigned",
  "project_next_action_added",
  "project_due_plan_added",
] as const satisfies readonly ContributionReason[];

/**
 * Members of the household / team. Tasks and projects can be
 * owned (explicitly or via inheritance) by a member.
 */
export const members = sqliteTable("members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  color: text("color").notNull(),
});

export const memberOidcIdentities = sqliteTable(
  "member_oidc_identities",
  {
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    email: text("email"),
    preferredUsername: text("preferred_username"),
    pictureUrl: text("picture_url"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.issuer, t.subject] }),
    unique("member_oidc_identities_member_unique").on(t.memberId),
  ],
);

export const oidcAuthFlows = sqliteTable("oidc_auth_flows", {
  stateHash: text("state_hash").primaryKey(),
  nonce: text("nonce").notNull(),
  pkceVerifier: text("pkce_verifier").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    lastSeenAt: text("last_seen_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("auth_sessions_member_idx").on(t.memberId)],
);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#64748b"),
  kind: text("kind").notNull().default("plain"),
  groupingMode: text("grouping_mode").notNull().default("auto"),
  sortPosition: integer("sort_position"),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  revision: integer("revision").notNull().default(1),
  title: text("title").notNull(),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("backlog"), // backlog | active | completed | archived
  ownerMemberId: integer("owner_member_id").references(() => members.id, {
    onDelete: "set null",
  }),
  dueDate: text("due_date"),
  scheduledDate: text("scheduled_date"),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/**
 * Structured completion criteria complementing the project's free-form
 * notes. Each row is one checkable "Erledigt, wenn …" line,
 * ordered by `position` within its project.
 */
export const projectAcceptanceCriteria = sqliteTable(
  "project_acceptance_criteria",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    checked: integer("checked", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("project_acceptance_criteria_project_idx").on(t.projectId)],
);

export const projectTags = sqliteTable(
  "project_tags",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.tagId] })],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    revision: integer("revision").notNull().default(1),
    projectId: integer("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    parentTaskId: integer("parent_task_id").references((): any => tasks.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status").notNull().default("actionable"),
    // Legacy storage retained to avoid rebuilding the referenced tasks table.
    // Domain responses derive clarification exclusively from status="captured".
    needsClarification: integer("needs_clarification", { mode: "boolean" })
      .notNull()
      .default(false),
    ownerMemberId: integer("owner_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    ownerInheritanceMode: text("owner_inheritance_mode")
      .notNull()
      .default("inherit"), // inherit | explicit | none
    createdByMemberId: integer("created_by_member_id").references(
      () => members.id,
      { onDelete: "set null" },
    ),
    dueDate: text("due_date"),
    scheduledDate: text("scheduled_date"),
    waitingFor: text("waiting_for"),
    priority: integer("priority"),
    size: text("size"), // nullable S | M | L | XL
    position: integer("position").notNull().default(0),
    completedAt: text("completed_at"),
    cancelledAt: text("cancelled_at"),
    recurrenceRule: text("recurrence_rule"),
    reminderAt: text("reminder_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("tasks_project_idx").on(t.projectId),
    index("tasks_parent_idx").on(t.parentTaskId),
    index("tasks_status_idx").on(t.status),
    index("tasks_size_idx").on(t.size),
  ],
);

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    actorMemberId: integer("actor_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    kind: text("kind", { enum: activityEventKinds }).notNull(),
    taskId: integer("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    projectId: integer("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    entityType: text("entity_type", { enum: activityEntityTypes }).notNull(),
    entityTitle: text("entity_title").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<ActivityEventMetadata>()
      .notNull()
      .default({}),
  },
  (t) => [
    index("activity_events_created_at_idx").on(t.createdAt, t.id),
    index("activity_events_actor_idx").on(
      t.actorMemberId,
      t.createdAt,
      t.id,
    ),
    index("activity_events_task_idx").on(
      t.taskId,
      t.createdAt,
      t.id,
    ),
    index("activity_events_project_idx").on(
      t.projectId,
      t.createdAt,
      t.id,
    ),
  ],
);

export const contributionEvents = sqliteTable(
  "contribution_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    activityEventId: integer("activity_event_id")
      .notNull()
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    actorMemberId: integer("actor_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    category: text("category", { enum: contributionCategories }).notNull(),
    reason: text("reason", { enum: contributionReasons }).notNull(),
    entityType: text("entity_type", { enum: activityEntityTypes }).notNull(),
    entityId: integer("entity_id").notNull(),
    policyPoints: integer("policy_points").notNull(),
    sharedPoints: integer("shared_points").notNull(),
    personalPoints: integer("personal_points").notNull(),
    neutralizedAt: text("neutralized_at"),
    neutralizedByActivityEventId: integer(
      "neutralized_by_activity_event_id",
    ).references(() => activityEvents.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("contribution_events_activity_unique").on(t.activityEventId),
    index("contribution_events_window_idx").on(t.createdAt, t.id),
    index("contribution_events_actor_cap_idx").on(
      t.actorMemberId,
      t.createdAt,
      t.category,
    ),
    index("contribution_events_entity_reason_idx").on(
      t.entityType,
      t.entityId,
      t.reason,
      t.createdAt,
    ),
  ],
);

export const taskTags = sqliteTable(
  "task_tags",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] })],
);

export const taskExcludedTags = sqliteTable(
  "task_excluded_tags",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] })],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: integer("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("task_dependencies_unique").on(t.taskId, t.dependsOnTaskId),
    index("task_dependencies_task_idx").on(t.taskId),
    index("task_dependencies_depends_on_idx").on(t.dependsOnTaskId),
  ],
);
