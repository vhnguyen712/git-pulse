/**
 * Programmatic verification stage for a run (see docs/build-plan.md). After an
 * agent finishes, GitPulse itself runs the repo's own checks (test/lint/build)
 * in the run's worktree and records the result — spending NO agent tokens. This
 * is deliberately cheaper than asking the agent to run its own tests, and it is
 * human-reviewed, never an auto-gate.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** Scripts we treat as verification steps, in the order they should run. */
const VERIFY_SCRIPT_ORDER = ["lint", "typecheck", "test", "build"] as const;

/** How many chars of a command's combined output to keep for the timeline. */
const OUTPUT_TAIL_CHARS = 4000;

export interface VerifyCommandResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  /** Tail of combined stdout+stderr, capped. */
  outputTail: string;
}

export interface VerifyResult {
  passed: boolean;
  results: VerifyCommandResult[];
  /** True when there was nothing to run (no configured/detected commands). */
  skipped: boolean;
}

/**
 * Pick verification commands from a package.json `scripts` map, in a sensible
 * order. Pure — unit-tested. Returns npm invocations for the scripts that exist.
 */
export function pickVerifyCommands(scripts: Record<string, unknown> | undefined | null): string[] {
  if (!scripts || typeof scripts !== "object") return [];
  return VERIFY_SCRIPT_ORDER.filter((name) => typeof scripts[name] === "string").map(
    (name) => `npm run ${name}`,
  );
}

/** Reads the worktree's package.json and derives default verify commands. */
export async function detectVerifyCommands(worktreePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(worktreePath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return pickVerifyCommands(pkg.scripts);
  } catch {
    return [];
  }
}

/** Roll individual command results up into a pass/fail summary. Pure — unit-tested. */
export function summarizeVerify(results: VerifyCommandResult[]): VerifyResult {
  return {
    results,
    skipped: results.length === 0,
    // All-pass only; an empty set is "skipped", not "passed".
    passed: results.length > 0 && results.every((r) => r.passed),
  };
}

/** Injectable command runner so tests don't spawn real processes. */
export type CommandRunner = (
  command: string,
  cwd: string,
) => Promise<{ exitCode: number | null; output: string }>;

const defaultRunner: CommandRunner = (command, cwd) =>
  new Promise((resolve) => {
    // `shell: true` lets a configured command like "npm run test" run verbatim.
    const child = spawn(command, { cwd, shell: true });
    let output = "";
    const append = (buf: Buffer) => {
      output += buf.toString("utf8");
      if (output.length > OUTPUT_TAIL_CHARS * 2) output = output.slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => resolve({ exitCode: null, output: `${output}\n${err.message}` }));
    child.on("close", (code) => resolve({ exitCode: code, output }));
  });

/**
 * Run each verification command in the worktree, stopping at the first failure
 * (later checks are moot once one fails). Returns a pass/fail summary plus each
 * command's capped output for the timeline. Never throws — a runner error
 * becomes a failed command result.
 */
export async function runVerification(
  worktreePath: string,
  commands: string[],
  opts?: { run?: CommandRunner },
): Promise<VerifyResult> {
  const run = opts?.run ?? defaultRunner;
  const results: VerifyCommandResult[] = [];
  for (const command of commands) {
    const { exitCode, output } = await run(command, worktreePath);
    const passed = exitCode === 0;
    results.push({ command, exitCode, passed, outputTail: output.slice(-OUTPUT_TAIL_CHARS) });
    if (!passed) break;
  }
  return summarizeVerify(results);
}
