ALTER TABLE interventions ADD COLUMN review_window_start TEXT;
--> statement-breakpoint
ALTER TABLE intervention_assessments ADD COLUMN review_key TEXT;
--> statement-breakpoint
ALTER TABLE intervention_assessments ADD COLUMN decision TEXT;
--> statement-breakpoint
ALTER TABLE intervention_assessments ADD COLUMN benefit TEXT;
--> statement-breakpoint
ALTER TABLE intervention_assessments ADD COLUMN obstacle TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE intervention_assessments ADD COLUMN evidence TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX intervention_review_key_idx ON intervention_assessments(intervention_id,review_key);
