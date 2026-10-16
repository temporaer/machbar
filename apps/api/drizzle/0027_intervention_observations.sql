-- No inferred plans or reports: existing manual journals retain their meaning.
CREATE TABLE intervention_observation_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, intervention_id INTEGER NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL, timezone TEXT NOT NULL, commitment TEXT NOT NULL,
  plan TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX observation_plan_effective_idx ON intervention_observation_plans(intervention_id, effective_from);
--> statement-breakpoint
CREATE TABLE intervention_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, intervention_id INTEGER NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
  plan_version_id INTEGER NOT NULL REFERENCES intervention_observation_plans(id), revision INTEGER NOT NULL DEFAULT 1,
  reference_date TEXT NOT NULL, submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  answer TEXT NOT NULL CHECK(answer IN ('met','not_met','unknown','no_opportunity')), notes TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX observation_reference_idx ON intervention_observations(intervention_id,reference_date);
