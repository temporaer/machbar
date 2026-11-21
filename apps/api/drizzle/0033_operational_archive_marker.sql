ALTER TABLE `work_items` ADD `operational_archived_at` text;--> statement-breakpoint
CREATE INDEX `work_items_operational_archive_idx` ON `work_items` (`operational_archived_at`,`parent_id`,`status`);