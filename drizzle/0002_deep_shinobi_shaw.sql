ALTER TABLE `ai_summaries` ADD `prompt_tokens` integer;--> statement-breakpoint
ALTER TABLE `ai_summaries` ADD `completion_tokens` integer;--> statement-breakpoint
ALTER TABLE `ai_summaries` ADD `total_tokens` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `last_viewed_at` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `cron_secret` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `cost_per_million_input` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `cost_per_million_output` text;