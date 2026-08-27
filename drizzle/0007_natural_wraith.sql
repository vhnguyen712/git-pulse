CREATE TABLE `project_overviews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`overview_json` text NOT NULL,
	`based_on_head_sha` text,
	`model` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_overviews_project_id_unique` ON `project_overviews` (`project_id`);