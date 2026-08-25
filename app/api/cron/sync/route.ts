import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { listRepos, GitHubConfigError, GitHubRateLimitError } from "@/lib/github";
import { syncProject, isProjectStale } from "@/lib/sync";
import { LlmConfigError, LlmOutputError, LlmUnavailableError } from "@/lib/llm";
import { resolveSettings } from "@/lib/settings";
import { logger } from "@/lib/logging";

/** Caps per invocation so one cron tick can't burn an unbounded amount of GitHub/LLM budget. */
const MAX_REPOS_PER_RUN = 10;
/** Spacing between syncs so a burst of stale repos doesn't hammer the GitHub API back-to-back. */
const DELAY_BETWEEN_SYNCS_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunEntry {
  owner: string;
  repo: string;
  result: "synced" | "up_to_date" | "error" | "analysis_unavailable";
  error?: string;
}

/**
 * Auto-sync endpoint for scheduled/background sync (roadmap #3). Not called
 * by the UI — trigger it from an OS scheduler (see README) with:
 *   Authorization: Bearer <cronSecret from Settings, or CRON_SECRET env>
 * Syncs pinned projects whose GitHub repo has been pushed to since their
 * last sync, using the same staleness check as the Overview's "unanalyzed
 * changes" badge (lib/sync.ts#isProjectStale).
 */
export async function POST(req: Request) {
  const { cronSecret } = await resolveSettings();
  if (!cronSecret) {
    return NextResponse.json(
      { error: "No cron secret configured. Set one in Settings, or CRON_SECRET in .env.local." },
      { status: 500 },
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  if (provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
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
    const results: RunEntry[] = [];

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
        logger.error(`cron sync failed for ${project.owner}/${project.repoName}`, err);
        results.push({
          owner: project.owner,
          repo: project.repoName,
          result: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
      if (i < toRun.length - 1) await sleep(DELAY_BETWEEN_SYNCS_MS);
    }

    return NextResponse.json({
      staleCount: stale.length,
      ranCount: toRun.length,
      results,
    });
  } catch (err) {
    if (err instanceof GitHubConfigError || err instanceof LlmConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof GitHubRateLimitError) {
      return NextResponse.json(
        { error: "rate_limited", resetAt: err.resetAt },
        { status: 429 },
      );
    }
    if (err instanceof LlmOutputError) {
      return NextResponse.json(
        { error: "llm_invalid_output", message: err.message },
        { status: 502 },
      );
    }
    if (err instanceof LlmUnavailableError) {
      return NextResponse.json(
        { error: "llm_unavailable", message: err.message },
        { status: 503 },
      );
    }
    logger.error("POST /api/cron/sync failed", err);
    return NextResponse.json({ error: "Cron sync failed." }, { status: 500 });
  }
}
