CREATE TABLE `push_notification_preferences` (
	`member_id` integer PRIMARY KEY NOT NULL,
	`project_assigned` integer DEFAULT true NOT NULL,
	`task_reminder` integer DEFAULT true NOT NULL,
	`context_entered` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
