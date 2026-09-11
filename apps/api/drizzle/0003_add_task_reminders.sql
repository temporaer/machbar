CREATE TABLE `notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_event_id` integer NOT NULL,
	`push_subscription_id` integer NOT NULL,
	`delivered_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`notification_event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`push_subscription_id`) REFERENCES `push_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_event_subscription_idx` ON `notification_deliveries` (`notification_event_id`,`push_subscription_id`);--> statement-breakpoint
CREATE TABLE `task_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`kind` text NOT NULL,
	`at` text,
	`days_before` integer,
	`time` text,
	`timezone` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_reminders_task_idx` ON `task_reminders` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_reminders_absolute_due_idx` ON `task_reminders` (`kind`,`at`);--> statement-breakpoint
INSERT INTO `task_reminders` (`task_id`, `kind`, `at`, `created_at`, `updated_at`)
SELECT `id`, 'absolute', `reminder_at`, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `work_items`
WHERE `reminder_at` IS NOT NULL;
--> statement-breakpoint
UPDATE `work_items` SET `reminder_at` = NULL WHERE `reminder_at` IS NOT NULL;
