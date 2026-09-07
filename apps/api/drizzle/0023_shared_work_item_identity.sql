CREATE TABLE `work_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL
);
--> statement-breakpoint
-- Tasks and projects have always used independent AUTOINCREMENT sequences,
-- so an existing deployment can easily have a task and a project sharing
-- the same numeric id (e.g. task #5 and project #5 both existing). Before
-- projects and tasks can share one identity space via `work_items`, any
-- such collision must be resolved: every existing project id (and every
-- column that references it) is shifted by a fixed, effectively-impossible
-- to reach offset, which is far beyond anything a household task tracker
-- will ever produce natively, guaranteeing the shifted project ids can
-- never collide with any existing or future task id.
UPDATE `projects` SET `id` = `id` + 1000000000;--> statement-breakpoint
UPDATE `tasks` SET `project_id` = `project_id` + 1000000000 WHERE `project_id` IS NOT NULL;--> statement-breakpoint
UPDATE `project_tags` SET `project_id` = `project_id` + 1000000000;--> statement-breakpoint
UPDATE `project_physical_contexts` SET `project_id` = `project_id` + 1000000000;--> statement-breakpoint
UPDATE `project_acceptance_criteria` SET `project_id` = `project_id` + 1000000000;--> statement-breakpoint
UPDATE `activity_events` SET `project_id` = `project_id` + 1000000000 WHERE `project_id` IS NOT NULL;--> statement-breakpoint
UPDATE `notification_events` SET `entity_id` = `entity_id` + 1000000000 WHERE `entity_type` = 'project';--> statement-breakpoint
UPDATE `contribution_events` SET `entity_id` = `entity_id` + 1000000000 WHERE `entity_type` = 'project';--> statement-breakpoint
-- Seed the shared identity table from the now-disjoint existing ids so
-- every current task and project keeps its id (renumbered projects keep
-- their new id) once the FK-backed rebuild below takes effect. Explicit id
-- inserts into an AUTOINCREMENT table still advance its internal sequence
-- to at least the inserted value, so ids allocated after this migration
-- continue past the highest id seeded here.
INSERT INTO `work_items` (`id`) SELECT `id` FROM `tasks`;--> statement-breakpoint
INSERT INTO `work_items` (`id`) SELECT `id` FROM `projects`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`owner_member_id` integer,
	`due_date` text,
	`scheduled_date` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`reviewed_at` text,
	FOREIGN KEY (`id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "revision", "title", "notes", "status", "owner_member_id", "due_date", "scheduled_date", "position", "created_at", "updated_at", "reviewed_at") SELECT "id", "revision", "title", "notes", "status", "owner_member_id", "due_date", "scheduled_date", "position", "created_at", "updated_at", "reviewed_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`project_id` integer,
	`parent_task_id` integer,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'actionable' NOT NULL,
	`needs_clarification` integer DEFAULT false NOT NULL,
	`owner_member_id` integer,
	`owner_inheritance_mode` text DEFAULT 'inherit' NOT NULL,
	`physical_context_inheritance_mode` text DEFAULT 'inherit' NOT NULL,
	`created_by_member_id` integer,
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
	`reviewed_at` text,
	FOREIGN KEY (`id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "revision", "project_id", "parent_task_id", "title", "notes", "status", "needs_clarification", "owner_member_id", "owner_inheritance_mode", "physical_context_inheritance_mode", "created_by_member_id", "due_date", "scheduled_date", "priority", "size", "position", "completed_at", "cancelled_at", "recurrence_rule", "repeat_after_days", "allowed_deviation_days", "reminder_at", "created_at", "updated_at", "reviewed_at") SELECT "id", "revision", "project_id", "parent_task_id", "title", "notes", "status", "needs_clarification", "owner_member_id", "owner_inheritance_mode", "physical_context_inheritance_mode", "created_by_member_id", "due_date", "scheduled_date", "priority", "size", "position", "completed_at", "cancelled_at", "recurrence_rule", "repeat_after_days", "allowed_deviation_days", "reminder_at", "created_at", "updated_at", "reviewed_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_task_id`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_size_idx` ON `tasks` (`size`);--> statement-breakpoint
CREATE INDEX `tasks_reminder_idx` ON `tasks` (`reminder_at`,`status`);
