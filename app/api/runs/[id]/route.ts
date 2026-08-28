import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logger } from "@/lib/logging";

/** One run's detail: the run row plus its full step timeline, oldest first. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const run = await db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, id) });
    if (!run) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }
    const steps = await db.query.runSteps.findMany({
      where: (s, { eq }) => eq(s.runId, id),
      orderBy: (s, { asc }) => asc(s.seq),
    });
    return NextResponse.json({ run, steps });
  } catch (err) {
    logger.error("GET /api/runs/[id] failed", err);
    return NextResponse.json({ error: "Failed to load run." }, { status: 500 });
  }
}
