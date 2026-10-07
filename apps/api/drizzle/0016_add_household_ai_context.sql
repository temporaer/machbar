CREATE TABLE `household_ai_context` (
	`id` integer PRIMARY KEY NOT NULL,
	`household_description` text,
	`long_term_direction` text,
	`suggestion_guidance` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
