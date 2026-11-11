CREATE TABLE `external_task_occurrences` (
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`occurrence_key` text NOT NULL,
	`scheduled_date` text NOT NULL,
	`task_id` integer,
	PRIMARY KEY(`source`, `source_key`, `occurrence_key`),
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `external_task_routine_members` (
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`task_id` integer NOT NULL,
	PRIMARY KEY(`source`, `source_key`, `task_id`),
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
