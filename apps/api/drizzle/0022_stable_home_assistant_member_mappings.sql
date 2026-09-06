PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_home_assistant_member_mappings` (
	`member_id` integer PRIMARY KEY NOT NULL,
	`external_person_id` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_home_assistant_member_mappings`("member_id", "external_person_id")
SELECT "member_id", "external_id" FROM (
	SELECT
		mapping."member_id" AS "member_id",
		person."external_id" AS "external_id",
		ROW_NUMBER() OVER (
			PARTITION BY person."external_id"
			ORDER BY
				CASE WHEN integration."revoked_at" IS NULL THEN 0 ELSE 1 END,
				COALESCE(integration."last_update_at", integration."connected_at") DESC
		) AS "rn"
	FROM `home_assistant_member_mappings` AS mapping
	INNER JOIN `home_assistant_people` AS person ON person."id" = mapping."person_id"
	INNER JOIN `home_assistant_integrations` AS integration ON integration."id" = person."integration_id"
) WHERE "rn" = 1;--> statement-breakpoint
DROP TABLE `home_assistant_member_mappings`;--> statement-breakpoint
ALTER TABLE `__new_home_assistant_member_mappings` RENAME TO `home_assistant_member_mappings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `home_assistant_member_mappings_external_person_id_unique` ON `home_assistant_member_mappings` (`external_person_id`);