CREATE TABLE `mcp_agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`member_id` integer NOT NULL,
	`scope` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_agents_token_hash_unique` ON `mcp_agents` (`token_hash`);--> statement-breakpoint
CREATE INDEX `mcp_agents_member_idx` ON `mcp_agents` (`member_id`);--> statement-breakpoint
CREATE INDEX `mcp_agents_active_idx` ON `mcp_agents` (`revoked_at`);