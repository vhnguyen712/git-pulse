import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionItems } from "@/lib/db/schema";
import {
  createIssue,
  GitHubConfigError,
  GitHubRateLimitError,
} from "@/lib/github";
import { createIssueRequestSchema } from "@/lib/schema";
import { logger } from "@/lib/logging";

function issueBody(description: string | null, source: string): string {
  const kind = source === "next_step" ? "Next step" : "Brainstorm idea";
  return `${description ?? ""}\n\n---\n_Suggested by GitPulse AI (${kind})._`;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = createIssueRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "actionItemId is required." }, { status: 400 });
  }

  try {
    const item = await db.query.actionItems.findFirst({
      where: (a, { eq }) => eq(a.id, parsed.data.actionItemId),
    });
    if (!item) {
      return NextResponse.json({ error: "Action item not found." }, { status: 404 });
    }

    // Idempotency: already synced (or dismissed) means "push" is a no-op —
    // return the current state instead of filing a duplicate issue.
    if (item.status === "synced") {
      return NextResponse.json({ actionItem: item, created: false });
    }
    if (item.status === "dismissed") {
      return NextResponse.json(
        { error: "This item was dismissed and can't be pushed." },
        { status: 409 },
      );
    }

    const project = await db.query.projects.findFirst({
      where: (p, { eq }) => eq(p.id, item.projectId),
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const issue = await createIssue(
      project.owner,
      project.repoName,
      item.title,
      issueBody(item.description, item.source),
    );

    const [updated] = await db
      .update(actionItems)
      .set({
        status: "synced",
        githubIssueNumber: issue.number,
        githubIssueUrl: issue.htmlUrl,
      })
      .where(eq(actionItems.id, item.id))
      .returning();

    return NextResponse.json({ actionItem: updated, created: true });
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
    logger.error("POST /api/issues failed", err);
    return NextResponse.json({ error: "Failed to create issue." }, { status: 500 });
  }
}
