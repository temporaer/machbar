PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__managed_external_reminders` (
	`external_task_link_id` integer NOT NULL,
	`reminder_id` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__managed_external_reminders`("external_task_link_id", "reminder_id")
SELECT "id", "managed_reminder_id"
FROM `external_task_links`
WHERE "managed_reminder_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `__new_external_task_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`task_id` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`withdrawn_task_revision` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_external_task_links`("id", "source", "source_key", "task_id", "state", "withdrawn_task_revision", "created_at", "updated_at")
SELECT "id", "source", "source_key", "task_id", "state", "withdrawn_task_revision", "created_at", "updated_at"
FROM `external_task_links`;
--> statement-breakpoint
DROP TABLE `external_task_links`;
--> statement-breakpoint
ALTER TABLE `__new_external_task_links` RENAME TO `external_task_links`;
--> statement-breakpoint
CREATE TABLE `external_task_link_managed_reminders` (
	`external_task_link_id` integer NOT NULL,
	`key` text NOT NULL,
	`reminder_id` integer NOT NULL,
	FOREIGN KEY (`external_task_link_id`) REFERENCES `external_task_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reminder_id`) REFERENCES `task_reminders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `external_task_link_managed_reminders`("external_task_link_id", "key", "reminder_id")
SELECT "external_task_link_id", 'default', "reminder_id"
FROM `__managed_external_reminders`;
--> statement-breakpoint
DROP TABLE `__managed_external_reminders`;
--> statement-breakpoint
CREATE INDEX `external_task_links_task_idx` ON `external_task_links` (`task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_task_links_identity_unique` ON `external_task_links` (`source`,`source_key`);
--> statement-breakpoint
CREATE INDEX `external_task_link_managed_reminders_link_idx` ON `external_task_link_managed_reminders` (`external_task_link_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_task_link_managed_reminders_link_key_unique` ON `external_task_link_managed_reminders` (`external_task_link_id`,`key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_task_link_managed_reminders_reminder_unique` ON `external_task_link_managed_reminders` (`reminder_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
