import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";

/** Repositories pinned to the dashboard. */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    repoName: text("repo_name").notNull(),
    repoUrl: text("repo_url").notNull(),
    /** The repo's default branch on GitHub, cached at pin time. */
    defaultBranch: text("default_branch").notNull().default("main"),
    /**
     * Branch the user chose to sync, when different from the default. Null
     * means "follow the default branch" — so a fresh pin (and every existing
     * row) keeps syncing `defaultBranch` with no extra config.
     */
    syncBranch: text("sync_branch"),
    /** HEAD sha as of the last successful sync — base for the next `compare` call. */
    lastSyncedSha: text("last_synced_sha"),
    lastSyncedAt: integer("last_synced_at"),
    /** Last time the project workspace page was opened — drives the "unread" action-item badge. */
    lastViewedAt: integer("last_viewed_at"),
    /** Absolute path to the repo's local clone — required to open an embedded terminal here. */
    localPath: text("local_path"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [unique().on(table.owner, table.repoName)],
);

/** Cached LLM analysis for a given commit range, keyed by (project, base_sha, head_sha). */
export const aiSummaries = sqliteTable(
  "ai_summaries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    /** Full validated LLM output: { summary, next_steps[], brainstorm_ideas[] } */
    summaryJson: text("summary_json").notNull(),
    model: text("model"),
    /** Token usage from the LLM call(s) that produced this analysis — null if the backend didn't report usage. */
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [unique().on(table.projectId, table.baseSha, table.headSha)],
);

/**
 * README-style living overview for a project, LLM-synthesized from the repo's
 * README plus the achievements/fixes/architecture accumulated across all syncs.
 * One row per project (overwritten on each regeneration) — a current-state
 * document, not a per-range cache like ai_summaries.
 */
export const projectOverviews = sqliteTable(
  "project_overviews",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Validated ProjectOverview JSON: { tagline, context, objective, highlighted_features[], architecture, tech_stack[] } */
    overviewJson: text("overview_json").notNull(),
    /** Head sha this overview was synthesized at — lets a sync tell if it's stale. */
    basedOnHeadSha: text("based_on_head_sha"),
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [unique().on(table.projectId)],
);

/** Individual next-step / brainstorm items surfaced from an AI summary. */
export const actionItems = sqliteTable("action_items", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  summaryId: text("summary_id").references(() => aiSummaries.id, {
    onDelete: "set null",
  }),
  /** Which LLM output block this item came from. */
  source: text("source", { enum: ["next_step", "brainstorm"] }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category"),
  priority: text("priority", { enum: ["high", "medium", "low"] }).default(
    "medium",
  ),
  status: text("status", {
    enum: ["suggested", "approved", "synced", "shipped", "dismissed"],
  })
    .notNull()
    .default("suggested"),
  githubIssueNumber: integer("github_issue_number"),
  githubIssueUrl: text("github_issue_url"),
  /**
   * PR opened for this item's `gitpulse/<id>` branch, if any — set by
   * lib/pulls.ts's reconcile pass or openDraftPullRequest, never cleared, so
   * the card's "View PR" link survives the PR being merged or closed. State
   * is kept current even after the PR leaves GitHub's open list: the reconcile
   * pass follow-up checks any item still recorded as draft/open and flips it
   * to merged/closed once GitHub reports it that way (see lib/pulls.ts).
   */
  githubPrNumber: integer("github_pr_number"),
  githubPrUrl: text("github_pr_url"),
  githubPrState: text("github_pr_state", { enum: ["draft", "open", "merged", "closed"] }),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

/**
 * Single-row local config store, edited from the Settings page. Lets a
 * single-user install be configured entirely from the UI instead of hand
 * editing .env.local. Values here take priority over env vars at read time
 * (see lib/settings.ts); env vars remain a valid fallback for headless/
 * Docker setups. This file is git-ignored (.gitpulse/) and never leaves
 * the server — same boundary as the rest of the app's secrets.
 */
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey().default("default"),
  githubToken: text("github_token"),
  llmBaseUrl: text("llm_base_url"),
  llmApiKey: text("llm_api_key"),
  llmModel: text("llm_model"),
  /** Shared secret required by POST /api/cron/sync (Authorization: Bearer <secret>). */
  cronSecret: text("cron_secret"),
  /** Optional display-only pricing used to estimate cost from stored token counts; never sent anywhere. */
  costPerMillionInput: text("cost_per_million_input"),
  costPerMillionOutput: text("cost_per_million_output"),
  /**
   * Per-agent CLI command/args overrides, as JSON: `{ [agentId]: { command?, args? } }`.
   * Lets an install point an agent at a non-PATH binary (see lib/terminal/agents.ts
   * for the registry of default commands this overrides).
   */
  agentOverrides: text("agent_overrides"),
  updatedAt: integer("updated_at"),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type AiSummary = typeof aiSummaries.$inferSelect;
export type NewAiSummary = typeof aiSummaries.$inferInsert;
export type ActionItem = typeof actionItems.$inferSelect;
export type NewActionItem = typeof actionItems.$inferInsert;
export type ProjectOverviewRow = typeof projectOverviews.$inferSelect;
export type NewProjectOverviewRow = typeof projectOverviews.$inferInsert;
export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
