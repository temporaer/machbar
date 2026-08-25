CREATE TABLE `project_acceptance_criteria` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`text` text NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_acceptance_criteria_project_idx` ON `project_acceptance_criteria` (`project_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`owner_member_id` integer,
	`context` text,
	`due_date` text,
	`scheduled_date` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "title", "status", "owner_member_id", "context", "due_date", "scheduled_date", "position", "created_at", "updated_at") SELECT "id", "title", "status", "owner_member_id", "context", "due_date", "scheduled_date", "position", "created_at", "updated_at" FROM `projects`;--> statement-breakpoint
INSERT INTO `project_acceptance_criteria` ("project_id", "text", "checked", "position", "created_at", "updated_at") SELECT "id", "description", 0, 0, "created_at", "updated_at" FROM `projects` WHERE "description" IS NOT NULL AND trim("description") <> '';--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `tasks` ADD `size` text;--> statement-breakpoint
CREATE INDEX `tasks_size_idx` ON `tasks` (`size`);