import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reconcilePullRequests, getPrCandidates, openDraftPullRequest } from "@/lib/pulls";
import { GitHubConfigError, GitHubRateLimitError } from "@/lib/github";
import { openPullRequestRequestSchema } from "@/lib/schema";
import { logger } from "@/lib/logging";

/**
 * Open pull requests for a repo (reconciled onto their action items' PR
 * columns) plus `gitpulse/*` branches that are ready to become a PR.
 * Backs the workspace's Pull Requests tab, both on initial load
 * (lib/workspace.ts calls reconcilePullRequests/getPrCandidates directly)
 * and on the tab's manual Refresh button (this route).
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const owner = params.get("owner");
  const repo = params.get("repo");
  if (!owner || !repo) {
    return NextResponse.json({ error: "owner and repo are required." }, { status: 400 });
  }

  const project = await db.query.projects.findFirst({
    where: (p, { and, eq }) => and(eq(p.owner, owner), eq(p.repoName, repo)),
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  try {
    const pulls = await reconcilePullRequests(project);
    const items = await db.query.actionItems.findMany({
      where: (a, { eq }) => eq(a.projectId, project.id),
    });
    const candidates = await getPrCandidates(project, pulls, items);
    return NextResponse.json({ pulls, candidates, actionItems: items });
  } catch (err) {
    if (err instanceof GitHubConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof GitHubRateLimitError) {
      return NextResponse.json({ error: "rate_limited", resetAt: err.resetAt }, { status: 429 });
    }
    logger.error("GET /api/pulls failed", err);
    return NextResponse.json({ error: "Failed to load pull requests." }, { status: 500 });
  }
}

/** Opens a draft PR for one action item's gitpulse/<id> branch. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = openPullRequestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "actionItemId is required." }, { status: 400 });
  }

  try {
    const result = await openDraftPullRequest(parsed.data.actionItemId);
    if (!result.ok) {
      const status = result.code === "no_branch" ? 409 : 404;
      return NextResponse.json({ error: result.message }, { status });
    }
    return NextResponse.json({ actionItem: result.actionItem, created: result.created });
  } catch (err) {
    if (err instanceof GitHubConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof GitHubRateLimitError) {
      return NextResponse.json({ error: "rate_limited", resetAt: err.resetAt }, { status: 429 });
    }
    logger.error("POST /api/pulls failed", err);
    return NextResponse.json({ error: "Failed to open pull request." }, { status: 500 });
  }
}
