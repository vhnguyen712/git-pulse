/**
 * Persists a run's timeline and fans it out to live subscribers (the cockpit's
 * WebSocket). Mirrors the in-memory registry pattern in lib/terminal/server.ts
 * (its `sessions` map + `activeWorktreePaths()`), but scoped to the
 * record/broadcast concern only — owning the actual child process (spawn,
 * pause, inject) is lib/runs/runner.ts's job, not this module's.
 */
import { eq } from "drizzle-orm";
import path from "node:path";
import { db } from "@/lib/db";
import { runs, runSteps } from "@/lib/db/schema";
import type { Run, RunStepRow, NewRunStepRow } from "@/lib/db/schema";
import type { ParsedEvent, RunStatus } from "@/lib/runs/types";
import { estimateCostMicroUsd, type CostPricing } from "@/lib/runs/cost";

export type RunEvent = { type: "step"; step: RunStepRow } | { type: "status"; run: Run };
export type RunEventListener = (event: RunEvent) => void;

interface RunRuntime {
  seq: number;
  worktreePath: string | null;
  listeners: Set<RunEventListener>;
}

// Keyed by run id, like the terminal's `sessions` map keyed by client sessionId.
const runtimes = new Map<string, RunRuntime>();

/** Registers a run's live runtime once its worktree (if any) is known. */
export function registerRun(runId: string, worktreePath: string | null): void {
  runtimes.set(runId, { seq: 0, worktreePath, listeners: new Set() });
}

/** Drops a run's live runtime (subscribers, seq counter) once it's finished. */
export function unregisterRun(runId: string): void {
  runtimes.delete(runId);
}

/**
 * Normalized, lowercased worktree paths of currently-live runs — the run
 * counterpart to lib/terminal/server.ts's `activeWorktreePaths()`. The
 * worktree cleanup API (app/api/worktrees) should treat both as "in use".
 */
export function activeRunWorktreePaths(): Set<string> {
  const paths = new Set<string>();
  for (const rt of runtimes.values()) {
    if (rt.worktreePath) paths.add(path.normalize(rt.worktreePath).toLowerCase());
  }
  return paths;
}

/** Subscribes to a live run's events (new steps, status changes); returns an unsubscribe fn. */
export function subscribeRun(runId: string, listener: RunEventListener): () => void {
  const rt = runtimes.get(runId);
  if (!rt) return () => {};
  rt.listeners.add(listener);
  return () => rt.listeners.delete(listener);
}

function broadcast(runId: string, event: RunEvent): void {
  const rt = runtimes.get(runId);
  if (!rt) return;
  for (const listener of rt.listeners) listener(event);
}

/**
 * Persists one parsed agent event as a `run_steps` row, rolls its token usage
 * (if any) into the run's running totals, and broadcasts both to subscribers.
 * `seq` comes from an in-memory, per-run counter rather than a DB round trip —
 * safe because a run has exactly one writer (its runner). Returns the
 * persisted step, plus the freshly updated run row when usage was recorded
 * (null otherwise) so callers can check the budget guard without a second query.
 */
export async function recordStep(
  runId: string,
  event: ParsedEvent,
  pricing: CostPricing,
): Promise<{ step: RunStepRow; run: Run | null }> {
  const rt = runtimes.get(runId);
  const seq = rt ? rt.seq++ : 0;

  const costEstimate = event.usage
    ? estimateCostMicroUsd(event.usage.promptTokens, event.usage.completionTokens, pricing)
    : null;

  const row: NewRunStepRow = {
    id: crypto.randomUUID(),
    runId,
    seq,
    type: event.type,
    tool: event.tool ?? null,
    skill: event.skill ?? null,
    title: event.title ?? null,
    payloadJson: event.payload !== undefined ? JSON.stringify(event.payload) : null,
    promptTokens: event.usage?.promptTokens ?? null,
    completionTokens: event.usage?.completionTokens ?? null,
    costEstimate,
  };

  const [step] = await db.insert(runSteps).values(row).returning();
  broadcast(runId, { type: "step", step });

  // Rolled up in plain JS (read-modify-write) rather than a SQL increment
  // fragment: a run has exactly one writer (its runner), so there's no
  // concurrent-update race to guard against at the SQL level, and plain
  // numbers keep this simple to reason about and to test.
  let run: Run | null = null;
  if (event.usage) {
    const current = await db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, runId) });
    if (current) {
      const promptTokens = (current.promptTokens ?? 0) + event.usage.promptTokens;
      const completionTokens = (current.completionTokens ?? 0) + event.usage.completionTokens;
      const totalTokens = (current.totalTokens ?? 0) + event.usage.totalTokens;
      const nextCostEstimate =
        costEstimate != null ? (current.costEstimate ?? 0) + costEstimate : current.costEstimate;
      [run] = await db
        .update(runs)
        .set({
          promptTokens,
          completionTokens,
          totalTokens,
          costEstimate: nextCostEstimate,
          updatedAt: Date.now(),
        })
        .where(eq(runs.id, runId))
        .returning();
      if (run) broadcast(runId, { type: "status", run });
    }
  }

  return { step, run };
}

/** Updates a run's status (and any accompanying fields) and broadcasts the change. */
export async function setRunStatus(
  runId: string,
  status: RunStatus,
  extra?: Partial<Pick<Run, "error" | "verifyPassed" | "durationMs" | "branch" | "worktreePath">>,
): Promise<Run | undefined> {
  const [run] = await db
    .update(runs)
    .set({ status, updatedAt: Date.now(), ...extra })
    .where(eq(runs.id, runId))
    .returning();
  if (run) broadcast(runId, { type: "status", run });
  return run;
}
