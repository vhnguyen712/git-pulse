import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startRunRequestSchema } from "@/lib/schema";
import { startRun } from "@/lib/runs/runner";
import { logger } from "@/lib/logging";

/**
 * Instrumented agent runs — the observable, controllable execution mode beside
 * the interactive embedded terminal (see docs/build-plan.md). GET lists runs
 * for a project; POST starts a new one.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const projectId = params.get("projectId");
  const actionItemId = params.get("actionItemId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required." }, { status: 400 });
  }

  try {
    const runs = await db.query.runs.findMany({
      where: (r, { and, eq }) =>
        and(eq(r.projectId, projectId), actionItemId ? eq(r.actionItemId, actionItemId) : undefined),
      orderBy: (r, { desc }) => desc(r.createdAt),
    });
    return NextResponse.json({ runs });
  } catch (err) {
    logger.error("GET /api/runs failed", err);
    return NextResponse.json({ error: "Failed to list runs." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = startRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "projectId, agentId, and config.prompt are required." }, { status: 400 });
  }

  try {
    const result = await startRun(parsed.data);
    if (!result.ok) {
      const status =
        result.code === "no_project" || result.code === "executable_not_found"
          ? 404
          : result.code === "unknown_agent"
            ? 400
            : 409; // no_local_path: project exists but isn't ready for a run
      return NextResponse.json({ error: result.message }, { status });
    }
    return NextResponse.json({ runId: result.runId }, { status: 201 });
  } catch (err) {
    logger.error("POST /api/runs failed", err);
    return NextResponse.json({ error: "Failed to start run." }, { status: 500 });
  }
}
