CREATE TABLE intervention_tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT, intervention_id INTEGER NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
 task_key TEXT NOT NULL, task_id INTEGER REFERENCES work_items(id) ON DELETE SET NULL,
 original_task_id INTEGER NOT NULL, title TEXT NOT NULL, input TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX intervention_task_key_idx ON intervention_tasks(intervention_id,task_key);
--> statement-breakpoint
INSERT INTO intervention_tasks(intervention_id,task_key,task_id,original_task_id,title,input)
 SELECT i.id,'legacy-check-in',w.id,w.id,w.title,
 json_object('key','legacy-check-in','title',w.title,'scheduledDate',w.scheduled_date,'repeatAfterDays',w.repeat_after_days,'allowedDeviationDays',w.allowed_deviation_days)
 FROM interventions i JOIN work_items w ON w.id=i.backing_task_id;
