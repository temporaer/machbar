-- Merges `tasks` and `projects` into one physical `work_items` table
-- (role-discriminated: role = 'task' | 'story'), unifies their duplicated
-- satellite tables (tags, physical contexts, acceptance criteria), merges
-- the polymorphic `activity_events.task_id`/`project_id` pair into one
-- `entity_id` FK, and makes archival an orthogonal `archived_at` timestamp
-- instead of a status value.
--
-- `parent_id` unifies the previous `tasks.parent_task_id` (task-under-task
-- nesting) and `tasks.project_id` (the flat "which story do I ultimately
-- belong to" shortcut, now removed): a nested task's parent becomes its
-- immediate parent task if it had one, otherwise its project. Stories have
-- no parent yet (nesting stories under stories has no legacy data to
-- migrate, but the column already supports it going forward).
--
-- Status remaps to the shared lifecycle vocabulary: task 'actionable' ->
-- 'active', task 'someday' -> 'backlog' (other task statuses unchanged);
-- project 'completed' -> 'done'. Project 'archived' has no equivalent
-- shared-vocabulary value (archival becomes an orthogonal `archived_at`
-- timestamp). The pre-merge `projects` table never recorded which status
-- a row was archived from (no `completed_at` column existed on
-- `projects` at all), so archived rows conservatively default to status
-- 'backlog' with `archived_at` set from `updated_at` (production has zero
-- archived projects today, verified directly against the live database
-- before writing this migration; this branch only matters for
-- synthetic/dev data).
PRAGMA foreign_keys = OFF;
--> statement-breakpoint
CREATE TABLE `work_item_acceptance_criteria` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_item_id` integer NOT NULL,
	`text` text NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_item_acceptance_criteria_work_item_idx` ON `work_item_acceptance_criteria` (`work_item_id`);
--> statement-breakpoint
CREATE TABLE `work_item_physical_contexts` (
	`work_item_id` integer NOT NULL,
	`context_id` integer NOT NULL,
	PRIMARY KEY(`work_item_id`, `context_id`),
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_id`) REFERENCES `physical_contexts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `work_item_tags` (
	`work_item_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`work_item_id`, `tag_id`),
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Rebuild `work_items` with the full unified column set, populated
-- directly from the still-present `tasks`/`projects` tables (read before
-- either is dropped below).
CREATE TABLE `__new_work_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`parent_id` integer REFERENCES work_items(id),
	`role` text NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'captured' NOT NULL,
	`archived_at` text,
	`needs_clarification` integer DEFAULT false NOT NULL,
	`owner_member_id` integer REFERENCES members(id),
	`owner_inheritance_mode` text DEFAULT 'inherit' NOT NULL,
	`physical_context_inheritance_mode` text DEFAULT 'inherit' NOT NULL,
	`created_by_member_id` integer REFERENCES members(id),
	`due_date` text,
	`scheduled_date` text,
	`priority` integer,
	`size` text,
	`position` integer DEFAULT 0 NOT NULL,
	`completed_at` text,
	`cancelled_at` text,
	`recurrence_rule` text,
	`repeat_after_days` integer,
	`allowed_deviation_days` integer,
	`reminder_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`reviewed_at` text
);
--> statement-breakpoint
INSERT INTO `__new_work_items`
  ("id", "revision", "parent_id", "role", "title", "notes", "status",
   "archived_at", "needs_clarification", "owner_member_id",
   "owner_inheritance_mode", "physical_context_inheritance_mode",
   "created_by_member_id", "due_date", "scheduled_date", "priority",
   "size", "position", "completed_at", "cancelled_at", "recurrence_rule",
   "repeat_after_days", "allowed_deviation_days", "reminder_at",
   "created_at", "updated_at", "reviewed_at")
SELECT
  t."id", t."revision",
  COALESCE(t."parent_task_id", t."project_id") AS parent_id,
  'task' AS role,
  t."title", t."notes",
  CASE t."status"
    WHEN 'actionable' THEN 'active'
    WHEN 'someday' THEN 'backlog'
    ELSE t."status"
  END AS status,
  NULL AS archived_at,
  t."needs_clarification", t."owner_member_id", t."owner_inheritance_mode",
  t."physical_context_inheritance_mode", t."created_by_member_id",
  t."due_date", t."scheduled_date", t."priority", t."size", t."position",
  t."completed_at", t."cancelled_at", t."recurrence_rule",
  t."repeat_after_days", t."allowed_deviation_days", t."reminder_at",
  t."created_at", t."updated_at", t."reviewed_at"
FROM `tasks` t
UNION ALL
SELECT
  p."id", p."revision",
  NULL AS parent_id,
  'story' AS role,
  p."title", p."notes",
  CASE p."status"
    WHEN 'completed' THEN 'done'
    WHEN 'archived' THEN 'backlog'
    ELSE p."status"
  END AS status,
  CASE WHEN p."status" = 'archived' THEN p."updated_at" ELSE NULL END AS archived_at,
  0 AS needs_clarification,
  p."owner_member_id",
  'inherit' AS owner_inheritance_mode,
  'inherit' AS physical_context_inheritance_mode,
  NULL AS created_by_member_id,
  p."due_date", p."scheduled_date",
  NULL AS priority, NULL AS size,
  p."position",
  CASE WHEN p."status" = 'completed' THEN p."updated_at" ELSE NULL END AS completed_at,
  NULL AS cancelled_at,
  NULL AS recurrence_rule, NULL AS repeat_after_days, NULL AS allowed_deviation_days,
  NULL AS reminder_at,
  p."created_at", p."updated_at", p."reviewed_at"
FROM `projects` p;
--> statement-breakpoint
DROP TABLE `work_items`;
--> statement-breakpoint
ALTER TABLE `__new_work_items` RENAME TO `work_items`;
--> statement-breakpoint
CREATE INDEX `work_items_parent_idx` ON `work_items` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `work_items_role_idx` ON `work_items` (`role`);
--> statement-breakpoint
CREATE INDEX `work_items_status_idx` ON `work_items` (`status`);
--> statement-breakpoint
CREATE INDEX `work_items_size_idx` ON `work_items` (`size`);
--> statement-breakpoint
CREATE INDEX `work_items_reminder_idx` ON `work_items` (`reminder_at`,`status`);
--> statement-breakpoint
INSERT INTO `work_item_tags` ("work_item_id", "tag_id")
SELECT "task_id", "tag_id" FROM `task_tags`
UNION ALL
SELECT "project_id", "tag_id" FROM `project_tags`;
--> statement-breakpoint
INSERT INTO `work_item_physical_contexts` ("work_item_id", "context_id")
SELECT "task_id", "context_id" FROM `task_physical_contexts`
UNION ALL
SELECT "project_id", "context_id" FROM `project_physical_contexts`;
--> statement-breakpoint
INSERT INTO `work_item_acceptance_criteria`
  ("id", "work_item_id", "text", "checked", "position", "created_at", "updated_at")
SELECT "id", "project_id", "text", "checked", "position", "created_at", "updated_at"
FROM `project_acceptance_criteria`;
--> statement-breakpoint
CREATE TABLE `__new_activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`actor_member_id` integer,
	`kind` text NOT NULL,
	`entity_id` integer,
	`entity_type` text NOT NULL,
	`entity_title` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`entity_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_activity_events`
  ("id", "created_at", "actor_member_id", "kind", "entity_id", "entity_type", "entity_title", "metadata")
SELECT
  "id", "created_at", "actor_member_id", "kind",
  COALESCE("task_id", "project_id") AS entity_id,
  "entity_type", "entity_title", "metadata"
FROM `activity_events`;
--> statement-breakpoint
DROP TABLE `activity_events`;
--> statement-breakpoint
ALTER TABLE `__new_activity_events` RENAME TO `activity_events`;
--> statement-breakpoint
CREATE INDEX `activity_events_created_at_idx` ON `activity_events` (`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `activity_events_actor_idx` ON `activity_events` (`actor_member_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `activity_events_entity_idx` ON `activity_events` (`entity_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `__new_task_dependencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`depends_on_task_id` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_task_dependencies`("id", "task_id", "depends_on_task_id") SELECT "id", "task_id", "depends_on_task_id" FROM `task_dependencies`;
--> statement-breakpoint
DROP TABLE `task_dependencies`;
--> statement-breakpoint
ALTER TABLE `__new_task_dependencies` RENAME TO `task_dependencies`;
--> statement-breakpoint
CREATE INDEX `task_dependencies_task_idx` ON `task_dependencies` (`task_id`);
--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on_idx` ON `task_dependencies` (`depends_on_task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependencies_unique` ON `task_dependencies` (`task_id`,`depends_on_task_id`);
--> statement-breakpoint
CREATE TABLE `__new_task_excluded_tags` (
	`task_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`task_id`, `tag_id`),
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_task_excluded_tags`("task_id", "tag_id") SELECT "task_id", "tag_id" FROM `task_excluded_tags`;
--> statement-breakpoint
DROP TABLE `task_excluded_tags`;
--> statement-breakpoint
ALTER TABLE `__new_task_excluded_tags` RENAME TO `task_excluded_tags`;
--> statement-breakpoint
CREATE TABLE `__new_task_external_waits` (
	`task_id` integer PRIMARY KEY NOT NULL,
	`waiting_for` text,
	`revisit_date` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_task_external_waits`("task_id", "waiting_for", "revisit_date", "created_at", "updated_at") SELECT "task_id", "waiting_for", "revisit_date", "created_at", "updated_at" FROM `task_external_waits`;
--> statement-breakpoint
DROP TABLE `task_external_waits`;
--> statement-breakpoint
ALTER TABLE `__new_task_external_waits` RENAME TO `task_external_waits`;
--> statement-breakpoint
CREATE TABLE `__new_task_recurrence_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`scheduled_date` text NOT NULL,
	`deadline_date` text NOT NULL,
	`completed_on` text NOT NULL,
	`completed_at` text NOT NULL,
	`result` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_task_recurrence_occurrences`("id", "task_id", "scheduled_date", "deadline_date", "completed_on", "completed_at", "result") SELECT "id", "task_id", "scheduled_date", "deadline_date", "completed_on", "completed_at", "result" FROM `task_recurrence_occurrences`;
--> statement-breakpoint
DROP TABLE `task_recurrence_occurrences`;
--> statement-breakpoint
ALTER TABLE `__new_task_recurrence_occurrences` RENAME TO `task_recurrence_occurrences`;
--> statement-breakpoint
CREATE INDEX `task_recurrence_occurrences_task_history_idx` ON `task_recurrence_occurrences` (`task_id`,`completed_at`,`id`);
--> statement-breakpoint
DROP TABLE `project_acceptance_criteria`;
--> statement-breakpoint
DROP TABLE `project_physical_contexts`;
--> statement-breakpoint
DROP TABLE `project_tags`;
--> statement-breakpoint
DROP TABLE `task_physical_contexts`;
--> statement-breakpoint
DROP TABLE `task_tags`;
--> statement-breakpoint
DROP TABLE `projects`;
--> statement-breakpoint
DROP TABLE `tasks`;
--> statement-breakpoint
PRAGMA foreign_keys = ON;
