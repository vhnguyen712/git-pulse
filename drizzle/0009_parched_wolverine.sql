CREATE TABLE `run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`tool` text,
	`skill` text,
	`title` text,
	`payload_json` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`cost_estimate` integer,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`action_item_id` text,
	`agent_id` text NOT NULL,
	`model` text,
	`worktree_path` text,
	`branch` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`config_json` text,
	`instrumented` integer DEFAULT true NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`cost_estimate` integer,
	`verify_passed` integer,
	`duration_ms` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`action_item_id`) REFERENCES `action_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `run_auto_verify` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `verify_commands` text;