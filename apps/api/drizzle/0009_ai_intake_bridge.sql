CREATE TABLE `external_work_item_refs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_item_id` integer NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_work_item_refs_source_external_idx` ON `external_work_item_refs` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `external_work_item_refs_work_item_idx` ON `external_work_item_refs` (`work_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_work_item_refs_unique` ON `external_work_item_refs` (`work_item_id`,`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `home_assistant_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` integer NOT NULL,
	`intake_job_id` text NOT NULL,
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
	FOREIGN KEY (`intake_job_id`) REFERENCES `intake_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `home_assistant_requests_status_lease_idx` ON `home_assistant_requests` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `home_assistant_requests_intake_job_idx` ON `home_assistant_requests` (`intake_job_id`);--> statement-breakpoint
CREATE TABLE `intake_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`intake_job_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`intake_job_id`) REFERENCES `intake_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `intake_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by_member_id` integer,
	`actor_member_id` integer,
	`scope` text DEFAULT 'household' NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`text` text,
	`plan_json` text,
	`draft_json` text,
	`error_json` text,
	`apply_results_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `intake_jobs_expires_idx` ON `intake_jobs` (`expires_at`);--> statement-breakpoint
ALTER TABLE `home_assistant_integrations` ADD `capabilities_json` text;--> statement-breakpoint
ALTER TABLE `home_assistant_integrations` ADD `last_request_poll_at` text;