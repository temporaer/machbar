ALTER TABLE `task_external_waits` ADD `revisit_date` text;
--> statement-breakpoint
UPDATE `task_external_waits`
SET `revisit_date` = (
  SELECT `scheduled_date`
  FROM `tasks`
  WHERE `tasks`.`id` = `task_external_waits`.`task_id`
);
--> statement-breakpoint
UPDATE `tasks`
SET `scheduled_date` = NULL
WHERE EXISTS (
  SELECT 1
  FROM `task_external_waits`
  WHERE `task_external_waits`.`task_id` = `tasks`.`id`
);