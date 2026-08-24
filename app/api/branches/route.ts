import { NextResponse } from "next/server";
import {
  listBranches,
  getRepo,
  GitHubConfigError,
  GitHubRateLimitError,
} from "@/lib/github";
import { logger } from "@/lib/logging";

/**
 * Branch list for a single repo, backing the per-repo branch picker in the
 * UI. Returns branch names (default first) plus the default branch name so
 * the client can pre-select it. Lazily fetched when a picker is opened, so
 * the Overview grid doesn't make one GitHub call per repo up front.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const owner = params.get("owner");
  const repo = params.get("repo");
  if (!owner || !repo) {
    return NextResponse.json(
      { error: "owner and repo are required." },
      { status: 400 },
    );
  }

  try {
    const [names, meta] = await Promise.all([
      listBranches(owner, repo),
      getRepo(owner, repo),
    ]);
    // Surface the default branch first; keep the rest alphabetical.
    const rest = names
      .filter((n) => n !== meta.defaultBranch)
      .sort((a, b) => a.localeCompare(b));
    const branches = names.includes(meta.defaultBranch)
      ? [meta.defaultBranch, ...rest]
      : rest;
    return NextResponse.json({ branches, defaultBranch: meta.defaultBranch });
  } catch (err) {
    if (err instanceof GitHubConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof GitHubRateLimitError) {
      return NextResponse.json(
        { error: "rate_limited", resetAt: err.resetAt },
        { status: 429 },
      );
    }
    logger.error("GET /api/branches failed", err);
    return NextResponse.json(
      { error: "Failed to load branches." },
      { status: 500 },
    );
  }
}
