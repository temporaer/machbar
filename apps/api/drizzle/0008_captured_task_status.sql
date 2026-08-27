UPDATE `tasks`
SET
  `status` = 'captured',
  `completed_at` = NULL,
  `cancelled_at` = NULL
WHERE `needs_clarification` = true;