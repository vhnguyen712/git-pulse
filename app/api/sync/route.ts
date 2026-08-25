import { NextResponse } from "next/server";
import { GitHubConfigError, GitHubRateLimitError } from "@/lib/github";
import { LlmConfigError, LlmOutputError, LlmUnavailableError } from "@/lib/llm";
import { syncRequestSchema } from "@/lib/schema";
import { syncProject } from "@/lib/sync";
import { logger } from "@/lib/logging";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = syncRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "owner and repo are required." },
      { status: 400 },
    );
  }
  const { owner, repo, branch } = parsed.data;

  try {
    const result = await syncProject(owner, repo, branch);
    return NextResponse.json(result);
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
    logger.error("POST /api/sync failed", err);
    return NextResponse.json(
      {
        error: "Sync failed.",
        detail: err instanceof Error ? err.message : undefined,
      },
      { status: 500 },
    );
  }
}
