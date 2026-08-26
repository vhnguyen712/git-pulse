import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import {
  listRecentCommits,
  getRepo,
  GitHubConfigError,
  GitHubRateLimitError,
  type CompareCommit,
  type PullRequestSummary,
} from "@/lib/github";
import {
  reconcilePullRequests,
  getPrCandidates,
  getConflictingPrs,
  type PrCandidate,
  type ConflictInfo,
} from "@/lib/pulls";
import type { Analysis } from "@/lib/schema";
import type { ActionItem, Project } from "@/lib/db/schema";
import { getProjectHistory, type SyncHistoryEntry } from "@/lib/history";
import { logger } from "@/lib/logging";

const ACTIVITY_COMMIT_COUNT = 30;

export interface WorkspaceData {
  project: Project | null;
  commits: CompareCommit[];
  latestSummary: Analysis | null;
  actionItems: ActionItem[];
  history: SyncHistoryEntry[];
  /** Branch the "Sync now" button will target: the stored choice, or the repo default. */
  syncBranch: string;
  /** Repo's open PRs, reconciled onto their action items' githubPr* columns. */
  pulls: PullRequestSummary[];
  /** gitpulse/<id> branches pushed but not yet turned into a PR. */
  prCandidates: PrCandidate[];
  /** action items whose open PR conflicts with the base branch. */
  conflicts: ConflictInfo[];
}

/**
 * Loads everything the workspace page needs to render without triggering a
 * fresh sync: live commit history (cheap, always fetched) plus the most
 * recent cached AI analysis and its action items (never re-calls the LLM —
 * that only happens via POST /api/sync).
 */
export async function getWorkspaceData(
  owner: string,
  repo: string,
): Promise<WorkspaceData> {
  const [project, commits] = await Promise.all([
    db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.owner, owner), eq(p.repoName, repo)),
    }),
    listRecentCommits(owner, repo, ACTIVITY_COMMIT_COUNT),
  ]);

  let latestSummary: Analysis | null = null;
  let items: ActionItem[] = [];
  let history: SyncHistoryEntry[] = [];
  let pulls: PullRequestSummary[] = [];
  let prCandidates: PrCandidate[] = [];
  let conflicts: ConflictInfo[] = [];
  // Pre-select the branch the picker should show: the user's stored override,
  // or GitHub's live default branch. Resolving the default live (rather than
  // trusting the possibly-stale projects.default_branch column) keeps this in
  // step with the Overview grid, which reads the default from listRepos.
  const syncBranch = project?.syncBranch ?? (await getRepo(owner, repo)).defaultBranch;

  if (project) {
    // Reconcile open PRs onto their action items' githubPr* columns *before*
    // loading the items below, so the rows this render sees are already
    // up to date — no separate client refetch needed for the card link to
    // appear. Config/rate-limit errors propagate to the caller (page.tsx
    // already renders a notice for them from getRepo above); anything else
    // is non-fatal — the workspace still renders, just without PR data.
    try {
      pulls = await reconcilePullRequests(project);
    } catch (err) {
      if (err instanceof GitHubConfigError || err instanceof GitHubRateLimitError) throw err;
      logger.error("reconcilePullRequests failed during workspace load", err);
    }

    const summaryRow = await db.query.aiSummaries.findFirst({
      where: (s, { eq }) => eq(s.projectId, project.id),
      orderBy: (s, { desc }) => desc(s.createdAt),
    });
    if (summaryRow) {
      latestSummary = JSON.parse(summaryRow.summaryJson) as Analysis;
      items = await db.query.actionItems.findMany({
        where: (a, { eq }) => eq(a.summaryId, summaryRow.id),
        orderBy: (a, { desc }) => desc(a.createdAt),
      });
    }

    try {
      prCandidates = await getPrCandidates(project, pulls, items);
    } catch (err) {
      if (err instanceof GitHubConfigError || err instanceof GitHubRateLimitError) throw err;
      logger.error("getPrCandidates failed during workspace load", err);
    }

    try {
      conflicts = await getConflictingPrs(project, items);
    } catch (err) {
      if (err instanceof GitHubConfigError || err instanceof GitHubRateLimitError) throw err;
      logger.error("getConflictingPrs failed during workspace load", err);
    }

    history = await getProjectHistory(project.id);

    // Opening the workspace clears its "new items" badge on the Overview —
    // fire-and-forget so it doesn't block the page render.
    void db
      .update(projects)
      .set({ lastViewedAt: Date.now() })
      .where(eq(projects.id, project.id));
  }

  return {
    project: project ?? null,
    commits,
    latestSummary,
    actionItems: items,
    history,
    syncBranch,
    pulls,
    prCandidates,
    conflicts,
  };
}
