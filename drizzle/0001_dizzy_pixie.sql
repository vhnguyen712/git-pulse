CREATE TABLE `settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`github_token` text,
	`llm_base_url` text,
	`llm_api_key` text,
	`llm_model` text,
	`updated_at` integer
);
