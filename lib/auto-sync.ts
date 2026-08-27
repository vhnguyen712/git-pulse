import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { listRepos } from "@/lib/github";
import { syncProject, isProjectStale } from "@/lib/sync";
import { logger } from "@/lib/logging";

/** Caps per sweep so one run can't burn an unbounded amount of GitHub/LLM budget. */
export const MAX_REPOS_PER_RUN = 10;
/** Spacing between syncs so a burst of stale repos doesn't hammer the GitHub API back-to-back. */
export const DELAY_BETWEEN_SYNCS_MS = 1500;
/** Interval used by the in-app scheduler when Settings has auto-sync on but no explicit interval. */
export const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 30;
/** Floor for the configurable interval — nothing shorter is honored, so a mis-typed "1" can't hammer GitHub every minute. */
export const MIN_AUTO_SYNC_INTERVAL_MINUTES = 5;

export interface AutoSyncRunEntry {
  owner: string;
  repo: string;
  result: "synced" | "up_to_date" | "error" | "analysis_unavailable";
  error?: string;
}

export interface AutoSyncResult {
  staleCount: number;
  ranCount: number;
  results: AutoSyncRunEntry[];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sync every pinned project whose GitHub repo has been pushed to since its
 * last sync, using the same staleness check as the Overview's "unanalyzed
 * changes" badge (lib/sync.ts#isProjectStale). Shared by the scheduled
 * auto-sync route (app/api/cron/sync/route.ts) and the in-app scheduler
 * (server.ts). Throws the GitHub/LLM domain errors that surface at the
 * listRepos stage; per-project sync failures are caught and reported per
 * entry so one bad repo never aborts the sweep.
 */
export async function runAutoSync(): Promise<AutoSyncResult> {
  const [pinned, liveRepos] = await Promise.all([
    db.select().from(projects),
    listRepos(),
  ]);
  const liveByFullName = new Map(liveRepos.map((r) => [r.fullName, r]));

  const stale = pinned.filter((p) => {
    const live = liveByFullName.get(`${p.owner}/${p.repoName}`);
    // No live match (renamed, deleted, or access lost) — nothing to sync against.
    if (!live) return false;
    return isProjectStale(p, live.pushedAt);
  });

  const toRun = stale.slice(0, MAX_REPOS_PER_RUN);
  const results: AutoSyncRunEntry[] = [];

  for (const [i, project] of toRun.entries()) {
    try {
      const result = await syncProject(project.owner, project.repoName);
      results.push({
        owner: project.owner,
        repo: project.repoName,
        result: result.analysisUnavailable
          ? "analysis_unavailable"
          : result.upToDate
            ? "up_to_date"
            : "synced",
        error: result.analysisError,
      });
    } catch (err) {
      logger.error(`auto-sync failed for ${project.owner}/${project.repoName}`, err);
      results.push({
        owner: project.owner,
        repo: project.repoName,
        result: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
    if (i < toRun.length - 1) await sleep(DELAY_BETWEEN_SYNCS_MS);
  }

  return { staleCount: stale.length, ranCount: toRun.length, results };
}

/** Clamp a stored interval (or its absence) to a sane, floored minute count. */
export function resolveIntervalMinutes(stored: number | null | undefined): number {
  if (stored == null || Number.isNaN(stored) || stored <= 0) {
    return DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
  }
  return Math.max(MIN_AUTO_SYNC_INTERVAL_MINUTES, Math.floor(stored));
}
