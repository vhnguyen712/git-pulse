import { db } from "@/lib/db";
import type { Run, RunStepRow } from "@/lib/db/schema";

export interface RunView {
  run: Run;
  steps: RunStepRow[];
}

/**
 * Server-side data load for the run cockpit page (app/project/[owner]/[repo]/runs/[runId]/page.tsx),
 * mirroring lib/workspace.ts's getWorkspaceData pattern: direct DB reads for
 * the page's initial render, then the client component (components/run-cockpit.tsx)
 * takes over via the live WebSocket for anything after that.
 */
export async function getRunView(runId: string): Promise<RunView | null> {
  const run = await db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, runId) });
  if (!run) return null;
  const steps = await db.query.runSteps.findMany({
    where: (s, { eq }) => eq(s.runId, runId),
    orderBy: (s, { asc }) => asc(s.seq),
  });
  return { run, steps };
}
