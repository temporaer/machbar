ALTER TABLE `work_items` ADD `not_before_at` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `not_before_date` text;--> statement-breakpoint
UPDATE `work_items`
SET `scheduled_date` = NULL
WHERE `role` = 'story'
  AND (`status` <> 'backlog' OR `archived_at` IS NOT NULL)
  AND `scheduled_date` IS NOT NULL;