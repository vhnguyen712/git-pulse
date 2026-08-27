import { NextResponse } from "next/server";
import { GitHubConfigError, GitHubRateLimitError } from "@/lib/github";
import { todoScanRequestSchema } from "@/lib/schema";
import { scanAndPersistTodos, TodoScanProjectNotFoundError } from "@/lib/todo-items";
import { logger } from "@/lib/logging";

/**
 * Scans a pinned project's repo for inline TODO/FIXME/HACK/XXX markers and
 * records new ones as `source: "todo"` action items (idempotent — re-scanning
 * only surfaces markers added since). Triggered on demand from the workspace,
 * not on every sync, to keep GitHub blob-fetch cost predictable.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = todoScanRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "owner and repo are required." }, { status: 400 });
  }
  const { owner, repo, branch } = parsed.data;

  try {
    const result = await scanAndPersistTodos(owner, repo, branch);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TodoScanProjectNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof GitHubConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof GitHubRateLimitError) {
      return NextResponse.json({ error: "rate_limited", resetAt: err.resetAt }, { status: 429 });
    }
    logger.error("POST /api/todo-scan failed", err);
    return NextResponse.json(
      { error: "TODO scan failed.", detail: err instanceof Error ? err.message : undefined },
      { status: 500 },
    );
  }
}
