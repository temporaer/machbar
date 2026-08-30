CREATE TABLE `task_external_waits` (
	`task_id` integer PRIMARY KEY NOT NULL,
	`waiting_for` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `task_external_waits` (`task_id`, `waiting_for`)
SELECT `id`, `waiting_for`
FROM `tasks`
WHERE `status` = 'waiting';
--> statement-breakpoint
UPDATE `tasks`
SET `status` = 'actionable'
WHERE `status` = 'waiting';
