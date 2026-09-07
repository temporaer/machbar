ALTER TABLE `tasks` DROP COLUMN `waiting_for`;
--> statement-breakpoint
UPDATE `activity_events`
SET `metadata` = json_set(`metadata`, '$.previousStatus', 'actionable')
WHERE json_extract(`metadata`, '$.previousStatus') = 'waiting';
--> statement-breakpoint
UPDATE `activity_events`
SET `metadata` = json_set(`metadata`, '$.nextStatus', 'actionable')
WHERE json_extract(`metadata`, '$.nextStatus') = 'waiting';