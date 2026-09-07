CREATE TABLE `task_recurrence_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`scheduled_date` text NOT NULL,
	`deadline_date` text NOT NULL,
	`completed_on` text NOT NULL,
	`completed_at` text NOT NULL,
	`result` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_recurrence_occurrences_task_history_idx` ON `task_recurrence_occurrences` (`task_id`,`completed_at`,`id`);--> statement-breakpoint
DROP INDEX `contribution_events_activity_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `contribution_events_activity_reason_unique` ON `contribution_events` (`activity_event_id`,`reason`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `repeat_after_days` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `allowed_deviation_days` integer;