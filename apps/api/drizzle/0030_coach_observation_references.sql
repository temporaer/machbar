ALTER TABLE intervention_assessments ADD COLUMN counted_observation_ids_json TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE interventions ADD COLUMN reminder_enabled INTEGER NOT NULL DEFAULT 1;
