PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_home_assistant_member_mappings` (
	`member_id` integer PRIMARY KEY NOT NULL,
	`external_person_id` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_home_assistant_member_mappings`("member_id", "external_person_id")
SELECT mapping."member_id", person."external_id"
FROM `home_assistant_member_mappings` AS mapping
INNER JOIN `home_assistant_people` AS person ON person."id" = mapping."person_id";--> statement-breakpoint
DROP TABLE `home_assistant_member_mappings`;--> statement-breakpoint
ALTER TABLE `__new_home_assistant_member_mappings` RENAME TO `home_assistant_member_mappings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `home_assistant_member_mappings_external_person_id_unique` ON `home_assistant_member_mappings` (`external_person_id`);