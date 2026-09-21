ALTER TABLE `work_items` ADD `task_kind` text;--> statement-breakpoint
UPDATE `work_items` SET `task_kind` = 'action' WHERE `role` = 'task';