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
  /**
   * Where this item came from: an LLM analysis block ("next_step" /
   * "brainstorm"), or the inline-comment scanner ("todo", see lib/todo-scan.ts).
   * The column is plain TEXT with no DB-level check, so this enum is a
   * TypeScript contract only — adding a value needs no migration.
   */
  source: text("source", { enum: ["next_step", "brainstorm", "todo"] }).notNull(),
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
   * In-app auto-sync scheduler (server.ts). When enabled, the long-lived
   * server process re-syncs every stale pinned project on the interval below —
   * the same stale-sweep the /api/cron/sync endpoint runs, no external
   * scheduler needed. Read fresh on each tick so a Settings change takes
   * effect with no restart. Null/false = disabled (the default).
   */
  autoSyncEnabled: integer("auto_sync_enabled", { mode: "boolean" }),
  /** Minutes between auto-sync sweeps when enabled. Null falls back to a built-in default (see lib/auto-sync.ts). */
  autoSyncIntervalMinutes: integer("auto_sync_interval_minutes"),
  /**
   * Per-agent CLI command/args overrides, as JSON: `{ [agentId]: { command?, args? } }`.
   * Lets an install point an agent at a non-PATH binary (see lib/terminal/agents.ts
   * for the registry of default commands this overrides).
   */
  agentOverrides: text("agent_overrides"),
  /**
   * Run cockpit defaults (see lib/runs/*). When `runAutoVerify` is on, a
   * finished instrumented run automatically runs the repo's own test/lint/build
   * in its worktree — programmatically, spending no agent tokens. `verifyCommands`
   * is a JSON string array (e.g. `["npm test","npm run lint"]`); null falls back
   * to commands detected from the worktree's package.json scripts.
   */
  runAutoVerify: integer("run_auto_verify", { mode: "boolean" }),
  verifyCommands: text("verify_commands"),
  updatedAt: integer("updated_at"),
});

/**
 * One instrumented agent run (see lib/runs/*). Unlike the interactive embedded
 * terminal — a raw byte stream with no visibility — a run is recorded as an
 * ordered `run_steps` timeline, each step stamped with tokens/cost, and is
 * controllable (pause/gate/budget/cancel) while it executes.
 */
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** Set when the run was launched from an action item; null for ad-hoc runs. */
  actionItemId: text("action_item_id").references(() => actionItems.id, {
    onDelete: "set null",
  }),
  /** Agent CLI id from lib/terminal/agents.ts: "claude" | "codex" | "antigravity". */
  agentId: text("agent_id").notNull(),
  model: text("model"),
  /** Dedicated git worktree the agent ran in, removed (non-force) when the run ends. */
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  status: text("status", {
    enum: [
      "queued",
      "running",
      "paused",
      "awaiting_approval",
      "verifying",
      "done",
      "failed",
      "cancelled",
    ],
  })
    .notNull()
    .default("queued"),
  /** Run config JSON: { prompt, model?, skills[], budgetTokens?, budgetUsd?, gating?, verify?, verifyCommands[] }. */
  configJson: text("config_json"),
  /**
   * False when the agent CLI has no structured output stream (e.g. a TUI-only
   * agent): the run is captured as raw message steps with no token/cost meter.
   */
  instrumented: integer("instrumented", { mode: "boolean" }).notNull().default(true),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  /** Estimated cost in micro-USD (integer, avoids float drift); the UI divides by 1e6. */
  costEstimate: integer("cost_estimate"),
  /** Result of the programmatic verification stage — null when it didn't run. */
  verifyPassed: integer("verify_passed", { mode: "boolean" }),
  durationMs: integer("duration_ms"),
  error: text("error"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at"),
});

/** Ordered flight-recorder timeline for a run — one row per emitted event. */
export const runSteps = sqliteTable("run_steps", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  /** Monotonic within a run, assigned by the recorder. */
  seq: integer("seq").notNull(),
  type: text("type", {
    enum: [
      "system",
      "message",
      "tool_use",
      "tool_result",
      "usage",
      "gate",
      "verify",
      "error",
    ],
  }).notNull(),
  /** Tool name for tool_use/tool_result steps. */
  tool: text("tool"),
  /** Skill/subagent name when one was active for this step. */
  skill: text("skill"),
  title: text("title"),
  /** Full event payload as JSON, for the step detail drawer. */
  payloadJson: text("payload_json"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  /** Estimated cost in micro-USD for this step. */
  costEstimate: integer("cost_estimate"),
  durationMs: integer("duration_ms"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
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
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunStepRow = typeof runSteps.$inferSelect;
export type NewRunStepRow = typeof runSteps.$inferInsert;
