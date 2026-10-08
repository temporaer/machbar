CREATE TABLE `household_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `household_settings` (`key`, `value`)
VALUES ('timezone', 'Europe/Berlin');
