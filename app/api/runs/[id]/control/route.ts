import { NextResponse } from "next/server";
import { runControlRequestSchema } from "@/lib/schema";
import { applyControl } from "@/lib/runs/runner";
import { logger } from "@/lib/logging";

/**
 * Human control over a live run: pause/resume/step/inject/cancel. Delegates
 * the actual legality + capability checks to lib/runs/runner.ts's
 * applyControl, which consults lib/runs/control.ts (status transition rules)
 * and the run's agent adapter (which controls it actually supports).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = runControlRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "action must be one of pause, resume, step, inject, cancel." },
      { status: 400 },
    );
  }

  try {
    const result = await applyControl(id, parsed.data.action, parsed.data.payload);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason ?? "Control action rejected." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("POST /api/runs/[id]/control failed", err);
    return NextResponse.json({ error: "Failed to apply control action." }, { status: 500 });
  }
}
