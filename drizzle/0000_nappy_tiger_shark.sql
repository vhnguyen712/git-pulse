CREATE TABLE `action_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`summary_id` text,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`category` text,
	`priority` text DEFAULT 'medium',
	`status` text DEFAULT 'suggested' NOT NULL,
	`github_issue_number` integer,
	`github_issue_url` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`summary_id`) REFERENCES `ai_summaries`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `ai_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`summary_json` text NOT NULL,
	`model` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_summaries_project_id_base_sha_head_sha_unique` ON `ai_summaries` (`project_id`,`base_sha`,`head_sha`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`repo_url` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`last_synced_sha` text,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_owner_repo_name_unique` ON `projects` (`owner`,`repo_name`);