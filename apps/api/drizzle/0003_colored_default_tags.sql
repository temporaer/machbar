ALTER TABLE `tags` ADD `color` text DEFAULT '#64748b' NOT NULL;
--> statement-breakpoint
UPDATE `tags`
SET `color` = CASE abs(`id`) % 10
  WHEN 0 THEN '#2563eb'
  WHEN 1 THEN '#7c3aed'
  WHEN 2 THEN '#c026d3'
  WHEN 3 THEN '#db2777'
  WHEN 4 THEN '#dc2626'
  WHEN 5 THEN '#ea580c'
  WHEN 6 THEN '#ca8a04'
  WHEN 7 THEN '#16a34a'
  WHEN 8 THEN '#0891b2'
  ELSE '#4f46e5'
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `tags` (`name`, `color`) VALUES
  ('Lars', '#2563eb'),
  ('Lea', '#c026d3'),
  ('Jonas', '#7c3aed'),
  ('Hannes', '#0891b2'),
  ('Sarah', '#db2777'),
  ('Schule', '#ca8a04'),
  ('Kita', '#ea580c'),
  ('Urlaub', '#4f46e5'),
  ('Haus', '#dc2626'),
  ('Garten', '#16a34a');