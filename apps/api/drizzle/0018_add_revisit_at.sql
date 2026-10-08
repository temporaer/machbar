ALTER TABLE `work_items` ADD `revisit_at` text;
CREATE TABLE IF NOT EXISTS `data_migrations` (
  `name` text PRIMARY KEY NOT NULL,
  `completed_at` text NOT NULL
);