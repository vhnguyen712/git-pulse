import { gt, eq, and, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, actionItems } from "@/lib/db/schema";
import { listRepos } from "@/lib/github";
import { isProjectStale } from "@/lib/sync";
import { computeRepoHealth, type RepoHealth } from "@/lib/portfolio";

export interface RepoCardData {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  /** Branch this repo will sync: the user's stored choice, or the default. */
  syncBranch: string;
  language: string | null;
  openIssuesCount: number;
  pushedAt: string | null;
  pinned: boolean;
  lastSyncedAt: number | null;
  /**
   * Heuristic, not a live HEAD comparison: true when the repo has never been
   * synced, or has been pushed to since the last sync. Avoids an extra
   * GitHub call per repo on every Hub load; POST /api/sync resolves the
   * real HEAD sha at sync time.
   */
  hasUnanalyzedChanges: boolean;
  /** Action items created since the project workspace was last opened. */
  newItemCount: number;
  /** Momentum score for pinned projects (see lib/portfolio.ts#computeRepoHealth); null for un-pinned repos. */
  health: RepoHealth | null;
}

/** actionItems.projectId -> count of open (suggested/approved) items, for the health score. */
async function getOpenItemCounts(pinnedIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (pinnedIds.length === 0) return counts;

  const rows = await db
    .select({ projectId: actionItems.projectId })
    .from(actionItems)
    .where(
      and(
        inArray(actionItems.projectId, pinnedIds),
        inArray(actionItems.status, ["suggested", "approved"]),
      ),
    );
  for (const r of rows) counts.set(r.projectId, (counts.get(r.projectId) ?? 0) + 1);
  return counts;
}

/** actionItems.projectId -> count of items created after that project's lastViewedAt (or all items, if never viewed). */
async function getNewItemCounts(
  pinned: { id: string; lastViewedAt: number | null }[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (pinned.length === 0) return counts;

  for (const p of pinned) {
    const rows = await db
      .select({ id: actionItems.id })
      .from(actionItems)
      .where(
        and(
          eq(actionItems.projectId, p.id),
          p.lastViewedAt != null
            ? gt(actionItems.createdAt, p.lastViewedAt)
            : undefined,
        ),
      );
    counts.set(p.id, rows.length);
  }
  return counts;
}

export async function getRepoCards(opts: { force?: boolean } = {}): Promise<RepoCardData[]> {
  const [repos, pinned] = await Promise.all([
    listRepos({ force: opts.force }),
    db.select().from(projects),
  ]);

  const pinnedByFullName = new Map(
    pinned.map((p) => [`${p.owner}/${p.repoName}`, p]),
  );
  const [newItemCounts, openItemCounts] = await Promise.all([
    getNewItemCounts(pinned),
    getOpenItemCounts(pinned.map((p) => p.id)),
  ]);

  return repos.map((r) => {
    const project = pinnedByFullName.get(r.fullName);
    const hasUnanalyzedChanges = project
      ? isProjectStale(project, r.pushedAt)
      : true;
    const newItemCount = project ? newItemCounts.get(project.id) ?? 0 : 0;
    // Health is only meaningful for pinned projects — un-pinned repos have no
    // sync history or tracked suggestions to score.
    const health = project
      ? computeRepoHealth({
          pushedAt: r.pushedAt,
          openItemCount: openItemCounts.get(project.id) ?? 0,
        })
      : null;

    return {
      owner: r.owner,
      name: r.name,
      fullName: r.fullName,
      htmlUrl: r.htmlUrl,
      defaultBranch: r.defaultBranch,
      syncBranch: project?.syncBranch ?? r.defaultBranch,
      language: r.language,
      openIssuesCount: r.openIssuesCount,
      pushedAt: r.pushedAt,
      pinned: Boolean(project),
      lastSyncedAt: project?.lastSyncedAt ?? null,
      hasUnanalyzedChanges,
      newItemCount,
      health,
    };
  });
}
