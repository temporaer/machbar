CREATE TABLE `contribution_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`activity_event_id` integer NOT NULL,
	`actor_member_id` integer,
	`category` text NOT NULL,
	`reason` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`policy_points` integer NOT NULL,
	`shared_points` integer NOT NULL,
	`personal_points` integer NOT NULL,
	`neutralized_at` text,
	`neutralized_by_activity_event_id` integer,
	FOREIGN KEY (`activity_event_id`) REFERENCES `activity_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`neutralized_by_activity_event_id`) REFERENCES `activity_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `contribution_events_window_idx` ON `contribution_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `contribution_events_actor_cap_idx` ON `contribution_events` (`actor_member_id`,`created_at`,`category`);--> statement-breakpoint
CREATE INDEX `contribution_events_entity_reason_idx` ON `contribution_events` (`entity_type`,`entity_id`,`reason`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `contribution_events_activity_unique` ON `contribution_events` (`activity_event_id`);