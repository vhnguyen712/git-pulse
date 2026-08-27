import { z } from "zod";

// Models occasionally reach for a synonym instead of the exact enum value
// (e.g. "enhancement" or "chore" for next_steps[].type) despite the schema
// spelled out in the prompt. Normalizing known synonyms before validation
// means one stray label doesn't sink the whole analysis — a value with no
// known mapping still falls through unchanged and fails validation as before.
const NEXT_STEP_TYPE_ALIASES: Record<string, "feature" | "bug" | "refactor"> = {
  enhancement: "feature",
  improvement: "feature",
  feat: "feature",
  fix: "bug",
  bugfix: "bug",
  hotfix: "bug",
  refactoring: "refactor",
  chore: "refactor",
  cleanup: "refactor",
  maintenance: "refactor",
  docs: "refactor",
  documentation: "refactor",
  test: "refactor",
  testing: "refactor",
  performance: "refactor",
};

const BRAINSTORM_CATEGORY_ALIASES: Record<string, "architecture" | "enhancement" | "performance"> = {
  design: "architecture",
  structure: "architecture",
  feature: "enhancement",
  improvement: "enhancement",
  optimization: "performance",
  speed: "performance",
};

function normalizeEnumValue(aliases: Record<string, string>) {
  return (val: unknown) => {
    if (typeof val !== "string") return val;
    const normalized = val.trim().toLowerCase();
    return aliases[normalized] ?? val;
  };
}

/** Structured output contract for a single LLM analysis call (spec §5). */
export const analysisSchema = z.object({
  summary: z.object({
    key_achievements: z.array(z.string()).default([]),
    fixes_and_refactoring: z.array(z.string()).default([]),
    architectural_changes: z.array(z.string()).default([]),
  }),
  next_steps: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        priority: z.enum(["high", "medium", "low"]),
        type: z.preprocess(
          normalizeEnumValue(NEXT_STEP_TYPE_ALIASES),
          z.enum(["feature", "bug", "refactor"]),
        ),
      }),
    )
    .default([]),
  brainstorm_ideas: z
    .array(
      z.object({
        title: z.string(),
        category: z.preprocess(
          normalizeEnumValue(BRAINSTORM_CATEGORY_ALIASES),
          z.enum(["architecture", "enhancement", "performance"]),
        ),
        rationale: z.string(),
      }),
    )
    .default([]),
});

export type Analysis = z.infer<typeof analysisSchema>;
export type NextStep = Analysis["next_steps"][number];
export type BrainstormIdea = Analysis["brainstorm_ideas"][number];

/** README-style living overview for a project — structured output contract for lib/llm.ts#synthesizeOverview. */
export const projectOverviewSchema = z.object({
  /** One-line description, e.g. what you'd put right under the project name. */
  tagline: z.string().default(""),
  /** What the project is / background — prose, a paragraph or two. */
  context: z.string().default(""),
  /** Goals / purpose — prose, a paragraph or two. */
  objective: z.string().default(""),
  highlighted_features: z
    .array(z.object({ name: z.string(), description: z.string() }))
    .default([]),
  architecture: z
    .object({
      /** Prose explaining the overall design. */
      overview: z.string().default(""),
      components: z
        .array(z.object({ name: z.string(), description: z.string() }))
        .default([]),
    })
    .default({ overview: "", components: [] }),
  tech_stack: z.array(z.string()).default([]),
});

export type ProjectOverview = z.infer<typeof projectOverviewSchema>;

/** Body for POST /api/sync */
export const syncRequestSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** Optional branch to sync; when omitted the project's stored/default branch is used. */
  branch: z.string().min(1).optional(),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/** Body for POST /api/issues */
export const createIssueRequestSchema = z.object({
  actionItemId: z.string().min(1),
});
export type CreateIssueRequest = z.infer<typeof createIssueRequestSchema>;

/** Body for POST /api/todo-scan — scans a pinned project's repo for inline TODO/FIXME markers. */
export const todoScanRequestSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** Optional branch to scan; when omitted the project's stored/default branch is used. */
  branch: z.string().min(1).optional(),
});
export type TodoScanRequest = z.infer<typeof todoScanRequestSchema>;

/** Body for POST /api/pulls — opens a draft PR for the item's gitpulse/<id> branch. */
export const openPullRequestRequestSchema = z.object({
  actionItemId: z.string().min(1),
});
export type OpenPullRequestRequest = z.infer<typeof openPullRequestRequestSchema>;

/** Body for DELETE /api/action-items — permanently removes a local action item. */
export const deleteActionItemRequestSchema = z.object({
  actionItemId: z.string().min(1),
});
export type DeleteActionItemRequest = z.infer<typeof deleteActionItemRequestSchema>;

/**
 * Body for PATCH /api/projects. Sets the absolute path to a project's local
 * clone, used to open an embedded terminal in that directory. Accepts a
 * Windows drive path (`C:\...` or `C:/...`) or a POSIX absolute path
 * (`/...`) — the app itself only runs locally, but the DB has no other way
 * to know the shape of the host filesystem.
 */
export const updateProjectLocalPathSchema = z.object({
  projectId: z.string().min(1),
  localPath: z
    .string()
    .min(1)
    .regex(/^([a-zA-Z]:[\\/]|\/)/, "Must be an absolute path."),
});
export type UpdateProjectLocalPathRequest = z.infer<typeof updateProjectLocalPathSchema>;

/**
 * Body for POST /api/settings. All fields optional — only keys present are
 * updated (see lib/settings.ts#upsertSettings); an empty string clears a
 * field back to its env-var fallback.
 */
export const settingsUpdateSchema = z.object({
  githubToken: z.string().optional(),
  llmBaseUrl: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmModel: z.string().optional(),
  cronSecret: z.string().optional(),
  costPerMillionInput: z.string().optional(),
  costPerMillionOutput: z.string().optional(),
  /** In-app auto-sync scheduler toggle (server.ts). */
  autoSyncEnabled: z.boolean().optional(),
  /** Minutes between sweeps; null clears it back to the built-in default. Floored in lib/auto-sync.ts. */
  autoSyncIntervalMinutes: z.number().int().positive().nullable().optional(),
  /** Per-agent CLI command/args overrides, keyed by agent id (see lib/terminal/agents.ts). */
  agentOverrides: z
    .record(z.string(), z.object({ command: z.string().optional(), args: z.array(z.string()).optional() }))
    .optional(),
});
export type SettingsUpdateRequest = z.infer<typeof settingsUpdateSchema>;

/** Body for POST /api/settings/clear-data — the Settings page's Danger Zone. */
export const clearDataRequestSchema = z
  .object({
    clearSettings: z.boolean().default(false),
    clearSyncData: z.boolean().default(false),
  })
  .refine((data) => data.clearSettings || data.clearSyncData, {
    message: "Select at least one category to clear.",
  });
export type ClearDataRequest = z.infer<typeof clearDataRequestSchema>;
