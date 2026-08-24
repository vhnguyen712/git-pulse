import { NextResponse } from "next/server";
import { getRepoCards } from "@/lib/repos";
import { GitHubConfigError, GitHubRateLimitError } from "@/lib/github";
import { logger } from "@/lib/logging";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const repos = await getRepoCards({ force });
    return NextResponse.json({ repos });
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
    logger.error("GET /api/repos failed", err);
    return NextResponse.json(
      { error: "Failed to load repositories." },
      { status: 500 },
    );
  }
}
