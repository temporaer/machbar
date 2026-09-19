ALTER TABLE `work_items` ADD `not_before_at` text;--> statement-breakpoint
UPDATE `work_items`
SET `scheduled_date` = NULL
WHERE `role` = 'story' AND `status` <> 'backlog' AND `scheduled_date` IS NOT NULL;