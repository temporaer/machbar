ALTER TABLE `tags` ADD `kind` text DEFAULT 'plain' NOT NULL;--> statement-breakpoint
ALTER TABLE `tags` ADD `grouping_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `tags` ADD `sort_position` integer;--> statement-breakpoint
UPDATE `tags`
SET `kind` = CASE
  WHEN `name` IN ('Haus', 'Garten', 'Mobilität', 'Urlaub') THEN 'area'
  WHEN `name` IN ('Hannes', 'Jonas', 'Lars', 'Lea', 'Sarah', 'Kita', 'Schule') THEN 'actor'
  ELSE 'plain'
END;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `context`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `context`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `context_inheritance_mode`;