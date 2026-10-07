CREATE TABLE `cleanup_round_items` (
	`id` text PRIMARY KEY NOT NULL,
	`cleanup_round_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`target_revision` integer NOT NULL,
	`context_json` text NOT NULL,
	`result_json` text,
	`status` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`cleanup_round_id`) REFERENCES `cleanup_rounds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cleanup_round_items_round_idx` ON `cleanup_round_items` (`cleanup_round_id`);--> statement-breakpoint
CREATE INDEX `cleanup_round_items_target_idx` ON `cleanup_round_items` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `cleanup_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by_member_id` integer,
	`actor_member_id` integer,
	`scope` text DEFAULT 'household' NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`context_json` text NOT NULL,
	`raw_response_json` text,
	`result_json` text,
	`error_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cleanup_rounds_expires_idx` ON `cleanup_rounds` (`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_home_assistant_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` integer NOT NULL,
	`intake_job_id` text,
	`cleanup_round_id` text,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`result_json` text,
	`error` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`integration_id`) REFERENCES `home_assistant_integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`intake_job_id`) REFERENCES `intake_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cleanup_round_id`) REFERENCES `cleanup_rounds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_home_assistant_requests`("id", "integration_id", "intake_job_id", "cleanup_round_id", "kind", "payload_json", "status", "attempts", "lease_token", "lease_expires_at", "result_json", "error", "created_at", "completed_at") SELECT "id", "integration_id", "intake_job_id", NULL, "kind", "payload_json", "status", "attempts", "lease_token", "lease_expires_at", "result_json", "error", "created_at", "completed_at" FROM `home_assistant_requests`;--> statement-breakpoint
DROP TABLE `home_assistant_requests`;--> statement-breakpoint
ALTER TABLE `__new_home_assistant_requests` RENAME TO `home_assistant_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `home_assistant_requests_status_lease_idx` ON `home_assistant_requests` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `home_assistant_requests_intake_job_idx` ON `home_assistant_requests` (`intake_job_id`);--> statement-breakpoint
CREATE INDEX `home_assistant_requests_cleanup_round_idx` ON `home_assistant_requests` (`cleanup_round_id`);