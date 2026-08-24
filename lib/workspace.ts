import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { listRecentCommits, getRepo, type CompareCommit } from "@/lib/github";
import type { Analysis } from "@/lib/schema";
import type { ActionItem, Project } from "@/lib/db/schema";
import { getProjectHistory, type SyncHistoryEntry } from "@/lib/history";

const ACTIVITY_COMMIT_COUNT = 30;

export interface WorkspaceData {
  project: Project | null;
  commits: CompareCommit[];
  latestSummary: Analysis | null;
  actionItems: ActionItem[];
  history: SyncHistoryEntry[];
  /** Branch the "Sync now" button will target: the stored choice, or the repo default. */
  syncBranch: string;
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
  // Pre-select the branch the picker should show: the user's stored override,
  // or GitHub's live default branch. Resolving the default live (rather than
  // trusting the possibly-stale projects.default_branch column) keeps this in
  // step with the Overview grid, which reads the default from listRepos.
  const syncBranch = project?.syncBranch ?? (await getRepo(owner, repo)).defaultBranch;

  if (project) {
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

    history = await getProjectHistory(project.id);

    // Opening the workspace clears its "new items" badge on the Overview —
    // fire-and-forget so it doesn't block the page render.
    void db
      .update(projects)
      .set({ lastViewedAt: Date.now() })
      .where(eq(projects.id, project.id));
  }

  return { project: project ?? null, commits, latestSummary, actionItems: items, history, syncBranch };
}
