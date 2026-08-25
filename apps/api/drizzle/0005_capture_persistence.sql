ALTER TABLE `tasks` ADD `needs_clarification` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `tasks` SET `needs_clarification` = true WHERE `status` = 'inbox';--> statement-breakpoint
UPDATE `tasks` SET `status` = 'actionable' WHERE `status` = 'inbox';