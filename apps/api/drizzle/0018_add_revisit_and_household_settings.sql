CREATE TABLE `household_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `household_settings` (`key`, `value`)
VALUES ('timezone', 'Europe/Berlin');
--> statement-breakpoint
ALTER TABLE `work_items` ADD `revisit_at` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `data_migrations` (
  `name` text PRIMARY KEY NOT NULL,
  `completed_at` text NOT NULL
);