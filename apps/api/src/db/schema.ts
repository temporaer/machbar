import { sql } from "drizzle-orm";
import type {
  ActivityEntityType,
  ActivityEventKind,
  ActivityEventMetadata,
  ContributionCategory,
  ContributionEntityType,
  ContributionReason,
  NotificationEntityType,
  NotificationKind,
  PushLocale,
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
  "task_external_wait_started",
  "task_external_wait_updated",
  "task_external_wait_resolved",
  "task_tags_changed",
  "task_contexts_changed",
  "project_created",
  "project_updated",
  "project_deleted",
  "project_status_changed",
  "project_tags_changed",
  "project_contexts_changed",
  "project_acceptance_criterion_added",
  "project_acceptance_criterion_updated",
  "project_acceptance_criterion_checked",
  "project_acceptance_criterion_removed",
] as const satisfies readonly ActivityEventKind[];

const activityEntityTypes = [
  "task",
  "project",
] as const satisfies readonly ActivityEntityType[];

const contributionEntityTypes = [
  "task",
  "project",
  "task_occurrence",
] as const satisfies readonly ContributionEntityType[];

const contributionCategories = [
  "completion",
  "planning",
] as const satisfies readonly ContributionCategory[];

const contributionReasons = [
  "task_completed",
  "recurrence_missed",
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

const notificationKinds = [
  "task_assigned",
  "project_assigned",
  "task_reminder",
  "context_entered",
] as const satisfies readonly NotificationKind[];

const notificationEntityTypes = [
  "task",
  "project",
] as const satisfies readonly NotificationEntityType[];

const pushLocales = ["de", "en"] as const satisfies readonly PushLocale[];

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

export const homeAssistantPairingCodes = sqliteTable("home_assistant_pairing_codes", {
  codeHash: text("code_hash").primaryKey(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  createdByMemberId: integer("created_by_member_id").references(() => members.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const homeAssistantIntegrations = sqliteTable(
  "home_assistant_integrations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    instanceId: text("instance_id").notNull().unique(),
    tokenHash: text("token_hash").notNull().unique(),
    protocolVersion: integer("protocol_version").notNull(),
    connectedAt: text("connected_at").notNull(),
    lastUpdateAt: text("last_update_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("home_assistant_integrations_active_idx").on(t.revokedAt)],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    endpoint: text("endpoint").notNull().unique(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    locale: text("locale", { enum: pushLocales }).notNull(),
    timezone: text("timezone"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("push_subscriptions_member_idx").on(t.memberId)],
);

export const pushNotificationPreferences = sqliteTable(
  "push_notification_preferences",
  {
    memberId: integer("member_id")
      .primaryKey()
      .references(() => members.id, { onDelete: "cascade" }),
    projectAssigned: integer("project_assigned", { mode: "boolean" })
      .notNull()
      .default(true),
    taskReminder: integer("task_reminder", { mode: "boolean" })
      .notNull()
      .default(true),
    contextEntered: integer("context_entered", { mode: "boolean" })
      .notNull()
      .default(true),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#64748b"),
  kind: text("kind").notNull().default("plain"),
  groupingMode: text("grouping_mode").notNull().default("auto"),
  sortPosition: integer("sort_position"),
});

export const physicalContexts = sqliteTable(
  "physical_contexts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source", { enum: ["home_assistant"] }).notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    unique("physical_contexts_source_external_unique").on(
      t.source,
      t.externalId,
    ),
  ],
);

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
  reviewedAt: text("reviewed_at"),
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

export const projectPhysicalContexts = sqliteTable(
  "project_physical_contexts",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    contextId: integer("context_id")
      .notNull()
      .references(() => physicalContexts.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.contextId] })],
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
    physicalContextInheritanceMode: text("physical_context_inheritance_mode")
      .notNull()
      .default("inherit"), // inherit | explicit | none
    createdByMemberId: integer("created_by_member_id").references(
      () => members.id,
      { onDelete: "set null" },
    ),
    dueDate: text("due_date"),
    scheduledDate: text("scheduled_date"),
    priority: integer("priority"),
    size: text("size"), // nullable S | M | L | XL
    position: integer("position").notNull().default(0),
    completedAt: text("completed_at"),
    cancelledAt: text("cancelled_at"),
    recurrenceRuleLegacy: text("recurrence_rule"),
    repeatAfterDays: integer("repeat_after_days"),
    allowedDeviationDays: integer("allowed_deviation_days"),
    reminderAt: text("reminder_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    reviewedAt: text("reviewed_at"),
  },
  (t) => [
    index("tasks_project_idx").on(t.projectId),
    index("tasks_parent_idx").on(t.parentTaskId),
    index("tasks_status_idx").on(t.status),
    index("tasks_size_idx").on(t.size),
    index("tasks_reminder_idx").on(t.reminderAt, t.status),
  ],
);

export const taskPhysicalContexts = sqliteTable(
  "task_physical_contexts",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    contextId: integer("context_id")
      .notNull()
      .references(() => physicalContexts.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.contextId] })],
);

export const taskExternalWaits = sqliteTable("task_external_waits", {
  taskId: integer("task_id")
    .primaryKey()
    .references(() => tasks.id, { onDelete: "cascade" }),
  waitingFor: text("waiting_for"),
  revisitDate: text("revisit_date"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const taskRecurrenceOccurrences = sqliteTable(
  "task_recurrence_occurrences",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    scheduledDate: text("scheduled_date").notNull(),
    deadlineDate: text("deadline_date").notNull(),
    completedOn: text("completed_on").notNull(),
    completedAt: text("completed_at").notNull(),
    result: text("result", { enum: ["hit", "miss"] }).notNull(),
  },
  (t) => [
    index("task_recurrence_occurrences_task_history_idx").on(
      t.taskId,
      t.completedAt,
      t.id,
    ),
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

export const notificationEvents = sqliteTable(
  "notification_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: notificationKinds }).notNull(),
    recipientMemberId: integer("recipient_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    actorMemberId: integer("actor_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    entityType: text("entity_type", { enum: notificationEntityTypes }).notNull(),
    entityId: integer("entity_id").notNull(),
    entityTitle: text("entity_title").notNull(),
    sourceKey: text("source_key").notNull().unique(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    processedAt: text("processed_at"),
  },
  (t) => [
    index("notification_events_pending_idx").on(t.processedAt, t.id),
    index("notification_events_recipient_idx").on(t.recipientMemberId, t.id),
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
    entityType: text("entity_type", { enum: contributionEntityTypes }).notNull(),
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
    unique("contribution_events_activity_reason_unique").on(
      t.activityEventId,
      t.reason,
    ),
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

export const homeAssistantPeople = sqliteTable(
  "home_assistant_people",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    integrationId: integer("integration_id")
      .notNull()
      .references(() => homeAssistantIntegrations.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    state: text("state", { enum: ["known", "unknown"] }).notNull(),
    observedAt: text("observed_at").notNull(),
  },
  (t) => [
    unique("home_assistant_people_integration_external_unique").on(
      t.integrationId,
      t.externalId,
    ),
  ],
);

export const homeAssistantPersonContexts = sqliteTable(
  "home_assistant_person_contexts",
  {
    personId: integer("person_id")
      .notNull()
      .references(() => homeAssistantPeople.id, { onDelete: "cascade" }),
    contextId: integer("context_id")
      .notNull()
      .references(() => physicalContexts.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.personId, t.contextId] })],
);

export const homeAssistantMemberMappings = sqliteTable(
  "home_assistant_member_mappings",
  {
    memberId: integer("member_id")
      .primaryKey()
      .references(() => members.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .unique()
      .references(() => homeAssistantPeople.id, { onDelete: "cascade" }),
  },
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
