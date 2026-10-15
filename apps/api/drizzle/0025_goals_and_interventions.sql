CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`owner_member_id` integer,
	`area` text DEFAULT 'personal' NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`concluded_at` text,
	`created_by_member_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `intervention_assessments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`intervention_id` integer NOT NULL,
	`assessed_at` text NOT NULL,
	`band` text NOT NULL,
	`rationale_md` text NOT NULL,
	`digest_window_start` text NOT NULL,
	`digest_window_end` text NOT NULL,
	`counted_item_ids_json` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`intervention_id`) REFERENCES `interventions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `intervention_assessments_intervention_idx` ON `intervention_assessments` (`intervention_id`);--> statement-breakpoint
CREATE TABLE `interventions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`goal_id` integer NOT NULL,
	`type` text NOT NULL,
	`commitment` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`start_date` text NOT NULL,
	`revisit_date` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`concluded_at` text,
	`backing_task_id` integer,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`backing_task_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `interventions_goal_idx` ON `interventions` (`goal_id`);