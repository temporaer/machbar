CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`actor_member_id` integer,
	`kind` text NOT NULL,
	`task_id` integer,
	`project_id` integer,
	`entity_type` text NOT NULL,
	`entity_title` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_events_created_at_idx` ON `activity_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_events_actor_idx` ON `activity_events` (`actor_member_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_events_task_idx` ON `activity_events` (`task_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_events_project_idx` ON `activity_events` (`project_id`,`created_at`,`id`);