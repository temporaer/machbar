UPDATE `tasks`
SET `scheduled_date` = NULL
WHERE `id` IN (
  SELECT `task_id`
  FROM `task_external_waits`
  WHERE `waiting_for` IS NULL
    OR trim(
      `waiting_for`,
      char(9) || char(10) || char(11) || char(12) || char(13) || ' '
    ) = ''
);
--> statement-breakpoint
DELETE FROM `task_external_waits`
WHERE `waiting_for` IS NULL
  OR trim(
    `waiting_for`,
    char(9) || char(10) || char(11) || char(12) || char(13) || ' '
  ) = '';