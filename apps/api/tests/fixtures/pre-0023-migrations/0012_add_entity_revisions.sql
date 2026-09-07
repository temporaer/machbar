ALTER TABLE `projects` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `revision` integer DEFAULT 1 NOT NULL;