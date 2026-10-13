ALTER TABLE `work_items` ADD `discussion_requested` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `work_items` SET `needs_clarification` = 1
WHERE `role` = 'task' AND `status` = 'captured'
  AND COALESCE(`task_kind`, 'action') = 'action';
