/**
 * Owns the live process for an instrumented run: spawning the agent CLI in its
 * worktree, feeding stdout through the adapter's parser into the recorder,
 * applying human control actions to the process, and finalizing the run
 * (optional verification, worktree teardown) once it exits.
 *
 * This is the "second, orchestrated run mode" beside the interactive embedded
 * terminal (lib/terminal/server.ts) — it reuses the same worktree lifecycle
 * and agent registry, but owns its own process registry (keyed by run id)
 * rather than the terminal's pty `sessions` map, since a run's control surface
 * (pause/resume/cancel via signals, budget-triggered auto-pause) is distinct
 * from a pty's raw keystroke bridge.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { runs } from "@/lib/db/schema";
import type { Run } from "@/lib/db/schema";
import { createSessionWorktree, removeSessionWorktree } from "@/lib/terminal/worktree";
import { effectiveAgentCommand, getAgent } from "@/lib/terminal/agents";
import { resolveExecutable } from "@/lib/terminal/exec";
import { resolveSettings } from "@/lib/settings";
import { branchNameForItem } from "@/lib/pull-branch";
import { getRunAdapter } from "@/lib/runs/adapters";
import type { AgentRunAdapter, ControlAction, RunConfig } from "@/lib/runs/types";
import { recordStep, registerRun, setRunStatus, unregisterRun } from "@/lib/runs/recorder";
import { budgetExceeded, controlSupported, resolveControl } from "@/lib/runs/control";
import { detectVerifyCommands, runVerification } from "@/lib/runs/verify";
import type { CostPricing } from "@/lib/runs/cost";
import { logger } from "@/lib/logging";

/** How long a cancelled process gets to exit on SIGTERM before SIGKILL. */
const CANCEL_GRACE_MS = 5000;

/**
 * Minimal surface this module needs from a spawned child process — matches
 * node:child_process's ChildProcess but is declared independently so tests can
 * supply a fake backed by a plain EventEmitter instead of a real process.
 */
export interface SpawnedProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  // "close" (not "exit") is used deliberately: Node's docs note stdio streams
  // may still have buffered, undelivered data when "exit" fires, while
  // "close" only fires once stdout/stderr have fully ended — so waiting for
  // it is what guarantees the last stdout events (e.g. a final `result` line)
  // have already reached the "data" handlers below before we finalize.
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export type SpawnFn = (command: string, args: string[], opts: { cwd: string }) => SpawnedProcess;

const defaultSpawn: SpawnFn = (command, args, opts) =>
  nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as SpawnedProcess;

export interface StartRunInput {
  projectId: string;
  actionItemId?: string | null;
  agentId: string;
  config: RunConfig;
}

export type StartRunResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      code: "no_project" | "no_local_path" | "unknown_agent" | "executable_not_found";
      message: string;
    };

interface RunProcessEntry {
  child: SpawnedProcess;
  adapter: AgentRunAdapter;
  pricing: CostPricing;
  config: RunConfig;
  repoPath: string;
  worktreePath: string | null;
  buffer: string;
  /** Serializes stdout-line processing so events land in arrival order. */
  queue: Promise<void>;
  cancelledByUser: boolean;
  budgetTripped: boolean;
  startedAt: number;
  killTimer: ReturnType<typeof setTimeout> | null;
}

// Keyed by run id — the run counterpart to lib/terminal/server.ts's pty `sessions` map.
const processes = new Map<string, RunProcessEntry>();

/** True when a run currently has a live, controllable process. */
export function isRunActive(runId: string): boolean {
  return processes.has(runId);
}

/**
 * Starts an instrumented run: resolves the project/agent/settings, creates a
 * dedicated worktree (same lifecycle as the embedded terminal), spawns the
 * agent, and wires its output into the recorder. Returns immediately once the
 * process is spawned — the run continues in the background; poll/subscribe via
 * the recorder or GET /api/runs/[id].
 */
export async function startRun(
  input: StartRunInput,
  deps?: { spawn?: SpawnFn },
): Promise<StartRunResult> {
  const spawnFn = deps?.spawn ?? defaultSpawn;

  const project = await db.query.projects.findFirst({
    where: (p, { eq }) => eq(p.id, input.projectId),
  });
  if (!project) return { ok: false, code: "no_project", message: "Project not found." };
  if (!project.localPath) {
    return { ok: false, code: "no_local_path", message: "This project has no local clone path set." };
  }

  const adapter = getRunAdapter(input.agentId);
  if (!adapter) {
    return { ok: false, code: "unknown_agent", message: `No run adapter for agent "${input.agentId}".` };
  }

  const settings = await resolveSettings();
  const agentDef = getAgent(input.agentId);
  const base = effectiveAgentCommand(agentDef, settings.agentOverrides[input.agentId]);
  const exePath = resolveExecutable(base.command);
  if (!exePath) {
    return {
      ok: false,
      code: "executable_not_found",
      message: `${agentDef.label} (\`${base.command}\`) was not found on PATH.`,
    };
  }

  const runId = crypto.randomUUID();
  const branch = input.actionItemId ? branchNameForItem(input.actionItemId) : null;

  await db.insert(runs).values({
    id: runId,
    projectId: input.projectId,
    actionItemId: input.actionItemId ?? null,
    agentId: input.agentId,
    model: input.config.model ?? null,
    branch,
    status: "queued",
    configJson: JSON.stringify(input.config),
    instrumented: adapter.supportsStructuredStream,
  });

  const worktreePath = await createSessionWorktree(
    project.localPath,
    runId,
    project.syncBranch ?? project.defaultBranch,
  );
  const cwd = worktreePath ?? project.localPath;

  await db.update(runs).set({ worktreePath, updatedAt: Date.now() }).where(eq(runs.id, runId));
  registerRun(runId, worktreePath);

  const pricing: CostPricing = {
    costPerMillionInput: settings.costPerMillionInput,
    costPerMillionOutput: settings.costPerMillionOutput,
  };

  const spec = adapter.buildSpawn({ command: exePath, args: base.args }, input.config);

  let child: SpawnedProcess;
  try {
    child = spawnFn(exePath, spec.args, { cwd });
  } catch (err) {
    logger.error(`Failed to spawn ${adapter.id} for run ${runId}`, err);
    await finalizeFailed(runId, project.localPath, worktreePath, `Failed to start ${agentDef.label}.`);
    return { ok: true, runId };
  }

  const entry: RunProcessEntry = {
    child,
    adapter,
    pricing,
    config: input.config,
    repoPath: project.localPath,
    worktreePath,
    buffer: "",
    queue: Promise.resolve(),
    cancelledByUser: false,
    budgetTripped: false,
    startedAt: Date.now(),
    killTimer: null,
  };
  processes.set(runId, entry);

  if (spec.stdin) child.stdin?.write(spec.stdin);

  child.stdout?.on("data", (chunk: Buffer | string) => onChunk(runId, entry, chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer | string) => onChunk(runId, entry, chunk.toString("utf8")));
  child.on("error", (err) => {
    logger.error(`Run ${runId} process error`, err);
    void finalize(runId, "failed", { error: err.message });
  });
  child.on("close", (code, signal) => {
    void handleExit(runId, code, signal);
  });

  await setRunStatus(runId, "running");
  return { ok: true, runId };
}

/** Queues one chunk's complete lines for in-order parsing, buffering any partial trailing line. */
function onChunk(runId: string, entry: RunProcessEntry, chunk: string): void {
  entry.buffer += chunk;
  const lines = entry.buffer.split("\n");
  entry.buffer = lines.pop() ?? "";
  if (lines.length === 0) return;

  entry.queue = entry.queue.then(async () => {
    for (const line of lines) {
      await processLine(runId, entry, line);
    }
  });
}

async function processLine(runId: string, entry: RunProcessEntry, line: string): Promise<void> {
  let events;
  try {
    events = entry.adapter.parseLine(line);
  } catch (err) {
    logger.error(`Run ${runId}: adapter failed to parse a line`, err);
    return;
  }
  for (const event of events) {
    const { run } = await recordStep(runId, event, entry.pricing);
    if (event.type === "usage" && run && !entry.budgetTripped) {
      await maybeTripBudget(runId, entry, run);
    }
  }
}

/** Checks the budget guard after a usage update and auto-pauses (or stops) the run if it's exceeded. */
async function maybeTripBudget(runId: string, entry: RunProcessEntry, run: Run): Promise<void> {
  const exceeded = budgetExceeded(
    { totalTokens: run.totalTokens ?? 0, costMicroUsd: run.costEstimate ?? null },
    entry.config,
  );
  if (!exceeded) return;
  entry.budgetTripped = true;

  const canPause = controlSupported("pause", entry.adapter) && process.platform !== "win32";
  await recordStep(
    runId,
    {
      type: "gate",
      title: canPause
        ? "Budget exceeded — run auto-paused."
        : "Budget exceeded — run auto-stopped (pause unsupported for this agent/platform).",
      payload: { totalTokens: run.totalTokens, costEstimate: run.costEstimate, config: entry.config },
    },
    entry.pricing,
  );

  if (canPause) {
    entry.child.kill("SIGSTOP");
    await setRunStatus(runId, "paused");
  } else {
    entry.cancelledByUser = false; // budget stop, not a user cancel — recorded as failed below via exit handling
    entry.child.kill("SIGCONT"); // in case it was already stopped, so SIGTERM below is actually delivered
    entry.child.kill("SIGTERM");
  }
}

async function handleExit(
  runId: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  const entry = processes.get(runId);
  if (!entry) return;
  if (entry.killTimer) clearTimeout(entry.killTimer);

  // Flush any final line that arrived with no trailing newline, then wait for
  // every already-queued chunk (this one included) to finish processing
  // before finalizing — otherwise the run's last events (e.g. a closing
  // `result`/usage line) could be persisted after we've already marked it done.
  if (entry.buffer) {
    const trailing = entry.buffer;
    entry.buffer = "";
    entry.queue = entry.queue.then(() => processLine(runId, entry, trailing));
  }
  await entry.queue;

  processes.delete(runId);
  unregisterRun(runId);

  const durationMs = Date.now() - entry.startedAt;

  if (entry.cancelledByUser) {
    await setRunStatus(runId, "cancelled", { durationMs });
  } else if (code === 0) {
    await finalizeSuccess(runId, entry, durationMs);
  } else {
    await setRunStatus(runId, "failed", {
      error: `${entry.adapter.id} exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`,
      durationMs,
    });
  }

  if (entry.worktreePath) {
    await removeSessionWorktree(entry.repoPath, entry.worktreePath);
  }
}

/** Runs the programmatic verification stage (if configured) and marks the run done. No agent tokens spent. */
async function finalizeSuccess(runId: string, entry: RunProcessEntry, durationMs: number): Promise<void> {
  const settings = await resolveSettings();
  const shouldVerify = entry.config.verify ?? settings.runAutoVerify;

  if (!shouldVerify || !entry.worktreePath) {
    await setRunStatus(runId, "done", { durationMs });
    return;
  }

  await setRunStatus(runId, "verifying");
  const commands =
    entry.config.verifyCommands && entry.config.verifyCommands.length > 0
      ? entry.config.verifyCommands
      : settings.verifyCommands.length > 0
        ? settings.verifyCommands
        : await detectVerifyCommands(entry.worktreePath);

  const result = await runVerification(entry.worktreePath, commands);
  await recordStep(
    runId,
    {
      type: "verify",
      title: result.skipped
        ? "No verification commands configured"
        : result.passed
          ? "Verification passed"
          : "Verification failed",
      payload: result,
    },
    entry.pricing,
  );

  await setRunStatus(runId, "done", {
    verifyPassed: result.skipped ? null : result.passed,
    durationMs,
  });
}

async function finalizeFailed(
  runId: string,
  repoPath: string,
  worktreePath: string | null,
  message: string,
): Promise<void> {
  unregisterRun(runId);
  await setRunStatus(runId, "failed", { error: message });
  if (worktreePath) await removeSessionWorktree(repoPath, worktreePath);
}

async function finalize(
  runId: string,
  status: "failed",
  extra: { error: string },
): Promise<void> {
  const entry = processes.get(runId);
  if (entry) {
    processes.delete(runId);
    unregisterRun(runId);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    if (entry.worktreePath) await removeSessionWorktree(entry.repoPath, entry.worktreePath);
  }
  await setRunStatus(runId, status, extra);
}

export interface ControlResult {
  ok: boolean;
  reason?: string;
}

/**
 * Applies a human control action to a live run. Checks both the status
 * transition's legality (control.ts) and the adapter's actual capability
 * before touching the process — cancel and the budget guard are always
 * available; pause/resume act via OS signals (SIGSTOP/SIGCONT, POSIX only);
 * step/inject are accepted only when a future adapter declares real support
 * (none do today — see the capability notes on lib/runs/adapters/claude.ts).
 */
export async function applyControl(
  runId: string,
  action: ControlAction,
  payload?: { text?: string },
): Promise<ControlResult> {
  const entry = processes.get(runId);
  if (!entry) return { ok: false, reason: "Run is not currently active." };

  const run = await db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, runId) });
  if (!run) return { ok: false, reason: "Run not found." };

  const decision = resolveControl(run.status, action);
  if (!decision.allowed) return { ok: false, reason: decision.reason };
  if (!controlSupported(action, entry.adapter)) {
    return { ok: false, reason: `${entry.adapter.id} does not support "${action}" runs.` };
  }

  switch (action) {
    case "cancel":
      entry.cancelledByUser = true;
      entry.child.kill("SIGCONT"); // in case it's paused — SIGTERM isn't delivered to a stopped process
      entry.child.kill("SIGTERM");
      entry.killTimer = setTimeout(() => entry.child.kill("SIGKILL"), CANCEL_GRACE_MS);
      break;
    case "pause":
      entry.child.kill("SIGSTOP");
      await setRunStatus(runId, "paused");
      break;
    case "resume":
    case "step":
      entry.child.kill("SIGCONT");
      await setRunStatus(runId, "running");
      break;
    case "inject":
      if (!payload?.text || !entry.child.stdin) return { ok: false, reason: "No guidance text provided." };
      entry.child.stdin.write(`${payload.text}\n`);
      break;
  }
  return { ok: true };
}
