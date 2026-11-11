CREATE TABLE `external_task_occurrences` (
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`occurrence_key` text NOT NULL,
	`scheduled_date` text NOT NULL,
	`task_id` integer,
	PRIMARY KEY(`source`, `source_key`, `occurrence_key`),
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE set null
);
