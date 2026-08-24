import { z } from "zod";

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
        type: z.enum(["feature", "bug", "refactor"]),
      }),
    )
    .default([]),
  brainstorm_ideas: z
    .array(
      z.object({
        title: z.string(),
        category: z.enum(["architecture", "enhancement", "performance"]),
        rationale: z.string(),
      }),
    )
    .default([]),
});

export type Analysis = z.infer<typeof analysisSchema>;
export type NextStep = Analysis["next_steps"][number];
export type BrainstormIdea = Analysis["brainstorm_ideas"][number];

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
});
export type SettingsUpdateRequest = z.infer<typeof settingsUpdateSchema>;
