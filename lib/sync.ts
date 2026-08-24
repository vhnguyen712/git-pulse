import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, aiSummaries, actionItems } from "@/lib/db/schema";
import type { ActionItem, Project } from "@/lib/db/schema";
import {
  getRepo,
  getBranchHeadSha,
  compare,
  GitHubNoCommonHistoryError,
  listRecentCommits,
  getReadme,
  getOpenIssues,
  type CompareCommit,
  type CompareFile,
} from "@/lib/github";
import { buildContext } from "@/lib/context";
import { analyze } from "@/lib/llm";
import type { Analysis } from "@/lib/schema";
import type { TokenUsage } from "@/lib/llm";

const FIRST_SYNC_COMMIT_COUNT = 30;
/** Sentinel base_sha for a repo's very first sync (no prior HEAD to diff from). */
const FIRST_SYNC_BASE = "";

export interface SyncResult {
  upToDate: boolean;
  project: Project;
  commits?: CompareCommit[];
  analysis?: Analysis;
  actionItems?: ActionItem[];
  cached?: boolean;
  usage?: TokenUsage | null;
}

/**
 * Core sync algorithm shared by the manual "Sync now" route
 * (app/api/sync/route.ts) and the scheduled auto-sync route
 * (app/api/cron/sync/route.ts). Finds/creates the pinned project, resolves
 * the commit range since the last sync, reuses a cached analysis for that
 * exact range or runs a fresh LLM analysis, persists action items, and
 * advances the sync cursor. Throws the same domain errors as the GitHub/LLM
 * clients (GitHubConfigError, GitHubRateLimitError, LlmConfigError,
 * LlmOutputError) — callers translate those to their own response shape.
 */
export async function syncProject(
  owner: string,
  repo: string,
  branch?: string,
): Promise<SyncResult> {
  // 1. Resolve live repo metadata up front so the default branch is always
  // GitHub's current one (not a possibly-stale cached column) and self-heal
  // the stored value if it has drifted.
  const meta = await getRepo(owner, repo);

  // 2. Find or create the pinned project row.
  let project = await db.query.projects.findFirst({
    where: (p, { and, eq }) => and(eq(p.owner, owner), eq(p.repoName, repo)),
  });

  if (!project) {
    const [created] = await db
      .insert(projects)
      .values({
        id: crypto.randomUUID(),
        owner,
        repoName: repo,
        repoUrl: meta.htmlUrl,
        defaultBranch: meta.defaultBranch,
        // A branch explicitly picked at first sync is only stored when it
        // differs from the default — null keeps "follow the default branch".
        syncBranch: branch && branch !== meta.defaultBranch ? branch : null,
      })
      .returning();
    project = created;
  } else if (project.defaultBranch !== meta.defaultBranch) {
    await db
      .update(projects)
      .set({ defaultBranch: meta.defaultBranch })
      .where(and(eq(projects.id, project.id)));
    project = { ...project, defaultBranch: meta.defaultBranch };
  }

  // 3. Resolve which branch to sync. An explicit `branch` overrides the
  // stored choice; otherwise fall back to the stored branch, then the default.
  const previousBranch = project.syncBranch ?? project.defaultBranch;
  const targetBranch = branch ?? previousBranch;
  const branchChanged = targetBranch !== previousBranch;

  if (branchChanged) {
    // Switching branches invalidates the old cursor (its base sha lives on a
    // different branch), so re-baseline: persist the new branch and treat the
    // next sync as a fresh one. Storing null when it matches the default keeps
    // the column meaning "follow the default branch".
    project = {
      ...project,
      syncBranch: targetBranch === project.defaultBranch ? null : targetBranch,
      lastSyncedSha: null,
    };
    await db
      .update(projects)
      .set({ syncBranch: project.syncBranch })
      .where(and(eq(projects.id, project.id)));
  }

  // 4. Resolve the commit range to analyze.
  const headSha = await getBranchHeadSha(owner, repo, targetBranch);
  const baseSha = project.lastSyncedSha ?? FIRST_SYNC_BASE;

  if (baseSha === headSha) {
    return { upToDate: true, project };
  }

  let commits: CompareCommit[];
  let files: CompareFile[];
  // May be reset to FIRST_SYNC_BASE below if the stored base can't be diffed —
  // the analysis is then keyed/stored as a fresh first sync.
  let effectiveBase = baseSha;
  if (baseSha === FIRST_SYNC_BASE) {
    commits = await listRecentCommits(owner, repo, FIRST_SYNC_COMMIT_COUNT);
    files = []; // no single base ref to diff against on a first sync
  } else {
    try {
      const cmp = await compare(owner, repo, baseSha, headSha);
      commits = cmp.commits;
      files = cmp.files;
    } catch (err) {
      if (!(err instanceof GitHubNoCommonHistoryError)) throw err;
      // The stored base sha no longer shares history with head (rewritten or
      // rebased history, or a branch switch to unrelated history). Re-baseline:
      // analyze recent commits as if this were the project's first sync.
      effectiveBase = FIRST_SYNC_BASE;
      commits = await listRecentCommits(owner, repo, FIRST_SYNC_COMMIT_COUNT);
      files = [];
    }
  }

  const [readme, openIssues] = await Promise.all([
    getReadme(owner, repo),
    getOpenIssues(owner, repo),
  ]);

  // 5. Reuse a cached analysis for this exact commit range if we have one.
  let analysis: Analysis;
  let summaryId: string;
  let usage: TokenUsage | null = null;
  const cached = await db.query.aiSummaries.findFirst({
    where: (s, { and, eq }) =>
      and(
        eq(s.projectId, project!.id),
        eq(s.baseSha, effectiveBase),
        eq(s.headSha, headSha),
      ),
  });

  if (cached) {
    analysis = JSON.parse(cached.summaryJson) as Analysis;
    summaryId = cached.id;
    usage =
      cached.promptTokens != null
        ? {
            promptTokens: cached.promptTokens,
            completionTokens: cached.completionTokens ?? 0,
            totalTokens: cached.totalTokens ?? 0,
          }
        : null;
  } else {
    const context = buildContext({ commits, files, readme, openIssues });
    const result = await analyze(context);
    analysis = result.analysis;
    usage = result.usage;

    summaryId = crypto.randomUUID();
    await db.insert(aiSummaries).values({
      id: summaryId,
      projectId: project.id,
      baseSha: effectiveBase,
      headSha,
      summaryJson: JSON.stringify(analysis),
      model: process.env.LLM_MODEL,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
    });

    const newItems = [
      ...analysis.next_steps.map((s) => ({
        id: crypto.randomUUID(),
        projectId: project!.id,
        summaryId,
        source: "next_step" as const,
        title: s.title,
        description: s.description,
        category: s.type,
        priority: s.priority,
        status: "suggested" as const,
      })),
      ...analysis.brainstorm_ideas.map((b) => ({
        id: crypto.randomUUID(),
        projectId: project!.id,
        summaryId,
        source: "brainstorm" as const,
        title: b.title,
        description: b.rationale,
        category: b.category,
        priority: "medium" as const,
        status: "suggested" as const,
      })),
    ];
    if (newItems.length > 0) {
      await db.insert(actionItems).values(newItems);
    }
  }

  // 6. Advance the sync cursor.
  await db
    .update(projects)
    .set({ lastSyncedSha: headSha, lastSyncedAt: Date.now() })
    .where(and(eq(projects.id, project.id)));

  const items = await db.query.actionItems.findMany({
    where: (a, { eq }) => eq(a.projectId, project!.id),
    orderBy: (a, { desc }) => desc(a.createdAt),
  });

  return {
    upToDate: false,
    project: { ...project, lastSyncedSha: headSha, lastSyncedAt: Date.now() },
    commits,
    analysis,
    actionItems: items,
    cached: Boolean(cached),
    usage,
  };
}

/** True when a pinned project has GitHub activity since its last sync. Shared by the Overview's "unanalyzed changes" badge and the cron auto-sync's staleness filter. */
export function isProjectStale(
  project: Pick<Project, "lastSyncedAt">,
  pushedAt: string | null,
): boolean {
  return (
    !project.lastSyncedAt ||
    (pushedAt !== null && new Date(pushedAt).getTime() > project.lastSyncedAt)
  );
}
