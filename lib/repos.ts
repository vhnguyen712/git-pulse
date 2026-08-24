import { gt, eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, actionItems } from "@/lib/db/schema";
import { listRepos } from "@/lib/github";
import { isProjectStale } from "@/lib/sync";

export interface RepoCardData {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
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
  const newItemCounts = await getNewItemCounts(pinned);

  return repos.map((r) => {
    const project = pinnedByFullName.get(r.fullName);
    const hasUnanalyzedChanges = project
      ? isProjectStale(project, r.pushedAt)
      : true;
    const newItemCount = project ? newItemCounts.get(project.id) ?? 0 : 0;

    return {
      owner: r.owner,
      name: r.name,
      fullName: r.fullName,
      htmlUrl: r.htmlUrl,
      defaultBranch: r.defaultBranch,
      language: r.language,
      openIssuesCount: r.openIssuesCount,
      pushedAt: r.pushedAt,
      pinned: Boolean(project),
      lastSyncedAt: project?.lastSyncedAt ?? null,
      hasUnanalyzedChanges,
      newItemCount,
    };
  });
}
