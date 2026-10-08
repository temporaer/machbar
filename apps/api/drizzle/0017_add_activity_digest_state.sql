CREATE TABLE `member_activity_digest_state` (
	`member_id` integer PRIMARY KEY NOT NULL,
	`acknowledged_through_event_id` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
