CREATE UNIQUE INDEX `members_name_unique` ON `members` (`name`);--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `marked_today`;