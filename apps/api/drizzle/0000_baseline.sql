CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`actor_member_id` integer,
	`kind` text NOT NULL,
	`task_id` integer,
	`project_id` integer,
	`entity_type` text NOT NULL,
	`entity_title` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_events_created_at_idx` ON `activity_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_events_actor_idx` ON `activity_events` (`actor_member_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_events_task_idx` ON `activity_events` (`task_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_events_project_idx` ON `activity_events` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`member_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_member_idx` ON `auth_sessions` (`member_id`);--> statement-breakpoint
CREATE TABLE `contribution_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`activity_event_id` integer NOT NULL,
	`actor_member_id` integer,
	`category` text NOT NULL,
	`reason` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`policy_points` integer NOT NULL,
	`shared_points` integer NOT NULL,
	`personal_points` integer NOT NULL,
	`neutralized_at` text,
	`neutralized_by_activity_event_id` integer,
	FOREIGN KEY (`activity_event_id`) REFERENCES `activity_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`neutralized_by_activity_event_id`) REFERENCES `activity_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `contribution_events_window_idx` ON `contribution_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `contribution_events_actor_cap_idx` ON `contribution_events` (`actor_member_id`,`created_at`,`category`);--> statement-breakpoint
CREATE INDEX `contribution_events_entity_reason_idx` ON `contribution_events` (`entity_type`,`entity_id`,`reason`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `contribution_events_activity_reason_unique` ON `contribution_events` (`activity_event_id`,`reason`);--> statement-breakpoint
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
	`external_person_id` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `home_assistant_member_mappings_external_person_id_unique` ON `home_assistant_member_mappings` (`external_person_id`);--> statement-breakpoint
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
CREATE TABLE `member_oidc_identities` (
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`member_id` integer NOT NULL,
	`email` text,
	`preferred_username` text,
	`picture_url` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`issuer`, `subject`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_oidc_identities_member_unique` ON `member_oidc_identities` (`member_id`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_name_unique` ON `members` (`name`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`recipient_member_id` integer NOT NULL,
	`actor_member_id` integer,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`entity_title` text NOT NULL,
	`source_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`processed_at` text,
	FOREIGN KEY (`recipient_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_source_key_unique` ON `notification_events` (`source_key`);--> statement-breakpoint
CREATE INDEX `notification_events_pending_idx` ON `notification_events` (`processed_at`,`id`);--> statement-breakpoint
CREATE INDEX `notification_events_recipient_idx` ON `notification_events` (`recipient_member_id`,`id`);--> statement-breakpoint
CREATE TABLE `oidc_auth_flows` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`pkce_verifier` text NOT NULL,
	`return_to` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
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
CREATE TABLE `project_acceptance_criteria` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`text` text NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_acceptance_criteria_project_idx` ON `project_acceptance_criteria` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_physical_contexts` (
	`project_id` integer NOT NULL,
	`context_id` integer NOT NULL,
	PRIMARY KEY(`project_id`, `context_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_id`) REFERENCES `physical_contexts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `project_tags` (
	`project_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`project_id`, `tag_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`owner_member_id` integer,
	`due_date` text,
	`scheduled_date` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`reviewed_at` text,
	FOREIGN KEY (`id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `push_notification_preferences` (
	`member_id` integer PRIMARY KEY NOT NULL,
	`project_assigned` integer DEFAULT true NOT NULL,
	`task_reminder` integer DEFAULT true NOT NULL,
	`context_entered` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint` text NOT NULL,
	`member_id` integer NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`locale` text NOT NULL,
	`timezone` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_member_idx` ON `push_subscriptions` (`member_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`kind` text DEFAULT 'plain' NOT NULL,
	`grouping_mode` text DEFAULT 'auto' NOT NULL,
	`sort_position` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`depends_on_task_id` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_dependencies_task_idx` ON `task_dependencies` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on_idx` ON `task_dependencies` (`depends_on_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependencies_unique` ON `task_dependencies` (`task_id`,`depends_on_task_id`);--> statement-breakpoint
CREATE TABLE `task_excluded_tags` (
	`task_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`task_id`, `tag_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_external_waits` (
	`task_id` integer PRIMARY KEY NOT NULL,
	`waiting_for` text,
	`revisit_date` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
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
CREATE TABLE `task_recurrence_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`scheduled_date` text NOT NULL,
	`deadline_date` text NOT NULL,
	`completed_on` text NOT NULL,
	`completed_at` text NOT NULL,
	`result` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_recurrence_occurrences_task_history_idx` ON `task_recurrence_occurrences` (`task_id`,`completed_at`,`id`);--> statement-breakpoint
CREATE TABLE `task_tags` (
	`task_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`task_id`, `tag_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`project_id` integer,
	`parent_task_id` integer,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'actionable' NOT NULL,
	`needs_clarification` integer DEFAULT false NOT NULL,
	`owner_member_id` integer,
	`owner_inheritance_mode` text DEFAULT 'inherit' NOT NULL,
	`physical_context_inheritance_mode` text DEFAULT 'inherit' NOT NULL,
	`created_by_member_id` integer,
	`due_date` text,
	`scheduled_date` text,
	`priority` integer,
	`size` text,
	`position` integer DEFAULT 0 NOT NULL,
	`completed_at` text,
	`cancelled_at` text,
	`recurrence_rule` text,
	`repeat_after_days` integer,
	`allowed_deviation_days` integer,
	`reminder_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`reviewed_at` text,
	FOREIGN KEY (`id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_task_id`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_size_idx` ON `tasks` (`size`);--> statement-breakpoint
CREATE INDEX `tasks_reminder_idx` ON `tasks` (`reminder_at`,`status`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL
);
--> statement-breakpoint
-- Default household member/context tags, seeded historically by migration
-- 0003_colored_default_tags.sql with colors, then classified into
-- area/actor `kind` by migration 0007_typed_tags_remove_context.sql's
-- backfill; both are preserved here as one seed so fresh installs land in
-- the same end state (`drizzle-kit generate` only diffs schema.ts DDL, not
-- one-time seed/backfill data).
INSERT OR IGNORE INTO `tags` (`name`, `color`, `kind`) VALUES
  ('Lars', '#2563eb', 'actor'),
  ('Lea', '#c026d3', 'actor'),
  ('Jonas', '#7c3aed', 'actor'),
  ('Hannes', '#0891b2', 'actor'),
  ('Sarah', '#db2777', 'actor'),
  ('Schule', '#ca8a04', 'actor'),
  ('Kita', '#ea580c', 'actor'),
  ('Urlaub', '#4f46e5', 'area'),
  ('Haus', '#dc2626', 'area'),
  ('Garten', '#16a34a', 'area');
