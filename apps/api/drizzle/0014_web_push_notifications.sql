CREATE TABLE `notification_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`recipient_member_id` integer NOT NULL,
	`actor_member_id` integer,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`entity_title` text NOT NULL,
	`source_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`processed_at` text,
	FOREIGN KEY (`recipient_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_source_key_unique` ON `notification_events` (`source_key`);--> statement-breakpoint
CREATE INDEX `notification_events_pending_idx` ON `notification_events` (`processed_at`,`id`);--> statement-breakpoint
CREATE INDEX `notification_events_recipient_idx` ON `notification_events` (`recipient_member_id`,`id`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint` text NOT NULL,
	`member_id` integer NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`locale` text NOT NULL,
	`timezone` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_member_idx` ON `push_subscriptions` (`member_id`);--> statement-breakpoint
CREATE INDEX `tasks_reminder_idx` ON `tasks` (`reminder_at`,`status`);