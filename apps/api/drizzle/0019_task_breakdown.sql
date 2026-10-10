ALTER TABLE intake_jobs ADD COLUMN breakdown_task_id integer;
--> statement-breakpoint
ALTER TABLE intake_jobs ADD COLUMN breakdown_snapshot_json text;
--> statement-breakpoint
ALTER TABLE intake_jobs ADD COLUMN breakdown_instruction text;
