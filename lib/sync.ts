import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, aiSummaries, actionItems } from "@/lib/db/schema";
import type { ActionItem, Project } from "@/lib/db/schema";
import {
  getRepo,
  getDefaultBranchHeadSha,
  compare,
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
export async function syncProject(owner: string, repo: string): Promise<SyncResult> {
  // 1. Find or create the pinned project row.
  let project = await db.query.projects.findFirst({
    where: (p, { and, eq }) => and(eq(p.owner, owner), eq(p.repoName, repo)),
  });

  if (!project) {
    const meta = await getRepo(owner, repo);
    const [created] = await db
      .insert(projects)
      .values({
        id: crypto.randomUUID(),
        owner,
        repoName: repo,
        repoUrl: meta.htmlUrl,
        defaultBranch: meta.defaultBranch,
      })
      .returning();
    project = created;
  }

  // 2. Resolve the commit range to analyze.
  const headSha = await getDefaultBranchHeadSha(owner, repo, project.defaultBranch);
  const baseSha = project.lastSyncedSha ?? FIRST_SYNC_BASE;

  if (baseSha === headSha) {
    return { upToDate: true, project };
  }

  let commits: CompareCommit[];
  let files: CompareFile[];
  if (baseSha === FIRST_SYNC_BASE) {
    commits = await listRecentCommits(owner, repo, FIRST_SYNC_COMMIT_COUNT);
    files = []; // no single base ref to diff against on a first sync
  } else {
    const cmp = await compare(owner, repo, baseSha, headSha);
    commits = cmp.commits;
    files = cmp.files;
  }

  const [readme, openIssues] = await Promise.all([
    getReadme(owner, repo),
    getOpenIssues(owner, repo),
  ]);

  // 3. Reuse a cached analysis for this exact commit range if we have one.
  let analysis: Analysis;
  let summaryId: string;
  let usage: TokenUsage | null = null;
  const cached = await db.query.aiSummaries.findFirst({
    where: (s, { and, eq }) =>
      and(
        eq(s.projectId, project!.id),
        eq(s.baseSha, baseSha),
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
      baseSha,
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

  // 4. Advance the sync cursor.
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
