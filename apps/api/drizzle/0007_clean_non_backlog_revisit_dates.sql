UPDATE `work_items`
SET `scheduled_date` = NULL
WHERE `role` = 'story'
  AND (`status` <> 'backlog' OR `archived_at` IS NOT NULL)
  AND `scheduled_date` IS NOT NULL;
