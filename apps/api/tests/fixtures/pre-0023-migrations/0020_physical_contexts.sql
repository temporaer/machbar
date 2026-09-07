DELETE FROM `tags` WHERE `kind` = 'context';--> statement-breakpoint
CREATE TABLE `home_assistant_integrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`connected_at` text NOT NULL,
	`last_update_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `home_assistant_integrations_instance_id_unique` ON `home_assistant_integrations` (`instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `home_assistant_integrations_token_hash_unique` ON `home_assistant_integrations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `home_assistant_integrations_active_idx` ON `home_assistant_integrations` (`revoked_at`);--> statement-breakpoint
CREATE TABLE `home_assistant_member_mappings` (
	`member_id` integer PRIMARY KEY NOT NULL,
	`person_id` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `home_assistant_people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `home_assistant_member_mappings_person_id_unique` ON `home_assistant_member_mappings` (`person_id`);--> statement-breakpoint
CREATE TABLE `home_assistant_pairing_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_by_member_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `home_assistant_people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`integration_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `home_assistant_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `home_assistant_people_integration_external_unique` ON `home_assistant_people` (`integration_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `home_assistant_person_contexts` (
	`person_id` integer NOT NULL,
	`context_id` integer NOT NULL,
	PRIMARY KEY(`person_id`, `context_id`),
	FOREIGN KEY (`person_id`) REFERENCES `home_assistant_people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_id`) REFERENCES `physical_contexts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `physical_contexts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `physical_contexts_source_external_unique` ON `physical_contexts` (`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `project_physical_contexts` (
	`project_id` integer NOT NULL,
	`context_id` integer NOT NULL,
	PRIMARY KEY(`project_id`, `context_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_id`) REFERENCES `physical_contexts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `task_physical_contexts` (
	`task_id` integer NOT NULL,
	`context_id` integer NOT NULL,
	PRIMARY KEY(`task_id`, `context_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_id`) REFERENCES `physical_contexts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `physical_context_inheritance_mode` text DEFAULT 'inherit' NOT NULL;