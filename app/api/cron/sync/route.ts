import { NextResponse } from "next/server";
import { GitHubConfigError, GitHubRateLimitError } from "@/lib/github";
import { LlmConfigError, LlmOutputError, LlmUnavailableError } from "@/lib/llm";
import { resolveSettings } from "@/lib/settings";
import { runAutoSync } from "@/lib/auto-sync";
import { logger } from "@/lib/logging";

/**
 * Auto-sync endpoint for scheduled/background sync (roadmap #3). Also
 * reachable via the in-app scheduler (server.ts), which calls the same
 * runAutoSync() sweep directly. Trigger this endpoint from an external
 * scheduler (see README) with:
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
    return NextResponse.json(await runAutoSync());
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
