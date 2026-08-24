import { NextResponse } from "next/server";
import { publishActionItem } from "@/lib/issues";
import { GitHubConfigError, GitHubRateLimitError } from "@/lib/github";
import { createIssueRequestSchema } from "@/lib/schema";
import { logger } from "@/lib/logging";

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
    const result = await publishActionItem(parsed.data.actionItemId);
    if (!result.ok) {
      const status =
        result.code === "dismissed" ? 409 : result.code === "not_found" ? 404 : 404;
      return NextResponse.json({ error: result.message }, { status });
    }
    return NextResponse.json({ actionItem: result.actionItem, created: result.created });
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
