CREATE TABLE `external_task_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`task_id` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_task_links_task_idx` ON `external_task_links` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_task_links_identity_unique` ON `external_task_links` (`source`,`source_key`);
