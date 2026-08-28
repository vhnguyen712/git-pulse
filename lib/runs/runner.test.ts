import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { runs as runsTable, runSteps as runStepsTable } from "@/lib/db/schema";
import type { AgentRunAdapter } from "@/lib/runs/types";
import type { SpawnedProcess } from "@/lib/runs/runner";

const {
  projectsFindFirstMock,
  runsFindFirstMock,
  insertValuesSpy,
  createSessionWorktreeMock,
  removeSessionWorktreeMock,
  resolveExecutableMock,
  resolveSettingsMock,
  getRunAdapterMock,
} = vi.hoisted(() => ({
  projectsFindFirstMock: vi.fn(),
  runsFindFirstMock: vi.fn(),
  insertValuesSpy: vi.fn(),
  createSessionWorktreeMock: vi.fn(),
  removeSessionWorktreeMock: vi.fn(),
  resolveExecutableMock: vi.fn(),
  resolveSettingsMock: vi.fn(),
  getRunAdapterMock: vi.fn(),
}));

// --- A tiny in-memory fake DB shared by runner.ts and recorder.ts (both import
// `@/lib/db`). Table identity (`table === runsTable`) routes each call, rather
// than reimplementing drizzle's query semantics. ---
const state: { project: Record<string, unknown> | undefined; run: Record<string, unknown> | undefined; steps: Record<string, unknown>[] } = {
  project: undefined,
  run: undefined,
  steps: [],
};

function dual<T>(compute: () => T) {
  return {
    returning: () => Promise.resolve([compute()]),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(compute()).then(onFulfilled, onRejected),
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      projects: { findFirst: projectsFindFirstMock },
      runs: { findFirst: runsFindFirstMock },
    },
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        insertValuesSpy(table, row);
        if (table === runsTable) {
          state.run = {
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            costEstimate: null,
            verifyPassed: null,
            durationMs: null,
            error: null,
            worktreePath: null,
            updatedAt: null,
            createdAt: Date.now(),
            ...row,
          };
          return dual(() => state.run);
        }
        if (table === runStepsTable) {
          const stored = { id: crypto.randomUUID(), createdAt: Date.now(), ...row };
          state.steps.push(stored);
          return dual(() => stored);
        }
        throw new Error("unexpected insert table");
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          if (table === runsTable) {
            state.run = { ...state.run, ...patch };
            return dual(() => state.run);
          }
          throw new Error("unexpected update table");
        },
      }),
    }),
  },
}));

vi.mock("@/lib/terminal/worktree", () => ({
  createSessionWorktree: createSessionWorktreeMock,
  removeSessionWorktree: removeSessionWorktreeMock,
}));

vi.mock("@/lib/terminal/exec", () => ({ resolveExecutable: resolveExecutableMock }));
vi.mock("@/lib/settings", () => ({ resolveSettings: resolveSettingsMock }));
vi.mock("@/lib/runs/adapters", () => ({ getRunAdapter: getRunAdapterMock }));

const { startRun, applyControl, isRunActive } = await import("./runner");

const EXE_PATH = "/usr/bin/fake-agent";

function testAdapter(overrides: Partial<AgentRunAdapter> = {}): AgentRunAdapter {
  return {
    id: "test-agent",
    supportsStructuredStream: true,
    supportsInjection: false,
    supportsGating: false,
    buildSpawn: (base, config) => ({ args: [...base.args, "--prompt", config.prompt] }),
    parseLine: (line) => (line.trim() ? [JSON.parse(line)] : []),
    ...overrides,
  };
}

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn() } as unknown as NodeJS.WritableStream;
  killCalls: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal ?? "SIGTERM");
    return true;
  }
}

function asSpawned(p: FakeProcess): SpawnedProcess {
  return p as unknown as SpawnedProcess;
}

function emitLine(proc: FakeProcess, event: object) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.project = {
    id: "proj-1",
    owner: "acme",
    repoName: "widgets",
    repoUrl: "https://github.com/acme/widgets",
    defaultBranch: "main",
    syncBranch: null,
    localPath: "/repo",
  };
  state.run = undefined;
  state.steps = [];

  projectsFindFirstMock.mockImplementation(async () => state.project);
  runsFindFirstMock.mockImplementation(async () => state.run);
  resolveExecutableMock.mockReturnValue(EXE_PATH);
  createSessionWorktreeMock.mockResolvedValue("/fake/worktree");
  removeSessionWorktreeMock.mockResolvedValue(undefined);
  resolveSettingsMock.mockResolvedValue({
    githubToken: null,
    llmBaseUrl: null,
    llmApiKey: null,
    llmModel: null,
    cronSecret: null,
    costPerMillionInput: "3",
    costPerMillionOutput: "15",
    autoSyncEnabled: false,
    autoSyncIntervalMinutes: null,
    agentOverrides: {},
    runAutoVerify: false,
    verifyCommands: [],
  });
  getRunAdapterMock.mockReturnValue(testAdapter());
});

describe("startRun", () => {
  it("resolves the project/executable, spawns via the adapter's args, and marks the run running", async () => {
    const proc = new FakeProcess();
    const spawnFn = vi.fn().mockReturnValue(asSpawned(proc));

    const result = await startRun(
      { projectId: "proj-1", agentId: "test-agent", config: { prompt: "do the thing", verify: false } },
      { spawn: spawnFn },
    );

    expect(result).toEqual({ ok: true, runId: expect.any(String) });
    expect(spawnFn).toHaveBeenCalledWith(EXE_PATH, ["--prompt", "do the thing"], { cwd: "/fake/worktree" });
    expect(createSessionWorktreeMock).toHaveBeenCalledWith("/repo", expect.any(String), "main");
    expect(state.run?.status).toBe("running");
  });

  it("fails fast when the executable can't be resolved on PATH", async () => {
    resolveExecutableMock.mockReturnValue(null);
    const result = await startRun(
      { projectId: "proj-1", agentId: "test-agent", config: { prompt: "x" } },
      { spawn: vi.fn() },
    );
    expect(result).toEqual({ ok: false, code: "executable_not_found", message: expect.any(String) });
  });

  it("fails fast when the project has no local clone path", async () => {
    state.project = { ...state.project, localPath: null };
    const result = await startRun(
      { projectId: "proj-1", agentId: "test-agent", config: { prompt: "x" } },
      { spawn: vi.fn() },
    );
    expect(result).toEqual({ ok: false, code: "no_local_path", message: expect.any(String) });
  });

  it("runs to completion: parses stdout events, rolls up usage, and finalizes done with no verify", async () => {
    const proc = new FakeProcess();
    const spawnFn = vi.fn().mockReturnValue(asSpawned(proc));

    const { runId } = (await startRun(
      { projectId: "proj-1", agentId: "test-agent", config: { prompt: "do it", verify: false } },
      { spawn: spawnFn },
    )) as { ok: true; runId: string };

    emitLine(proc, { type: "message", title: "working" });
    emitLine(proc, { type: "usage", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } });
    proc.emit("close", 0, null);

    await waitUntil(() => state.run?.status === "done");

    expect(state.run).toMatchObject({ status: "done", promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    expect(state.steps.map((s) => s.type)).toEqual(["message", "usage"]);
    expect(removeSessionWorktreeMock).toHaveBeenCalledWith("/repo", "/fake/worktree");
    expect(isRunActive(runId)).toBe(false);
  });

  it("runs the programmatic verification stage on success when configured, spending no agent tokens", async () => {
    const proc = new FakeProcess();
    const spawnFn = vi.fn().mockReturnValue(asSpawned(proc));

    await startRun(
      { projectId: "proj-1", agentId: "test-agent", config: { prompt: "do it", verify: true, verifyCommands: [] } },
      { spawn: spawnFn },
    );
    emitLine(proc, { type: "message", title: "working" });
    proc.emit("close", 0, null);

    await waitUntil(() => state.run?.status === "done");
    expect(state.steps.some((s) => s.type === "verify")).toBe(true);
    // Regression check: the verify step (recorded after the process exits) must
    // not collide in seq with steps recorded while the process was still live —
    // this broke once when the recorder's runtime was unregistered too early.
    const seqs = state.steps.map((s) => s.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // No verify commands configured and no package.json in the fake worktree → skipped, not passed.
    expect(state.run?.verifyPassed).toBeNull();
  });

  it("marks the run failed on a non-zero exit", async () => {
    const proc = new FakeProcess();
    const spawnFn = vi.fn().mockReturnValue(asSpawned(proc));
    await startRun({ projectId: "proj-1", agentId: "test-agent", config: { prompt: "x" } }, { spawn: spawnFn });
    proc.emit("close", 1, null);
    await waitUntil(() => state.run?.status === "failed");
    expect(state.run?.error).toContain("code 1");
  });

  it("auto-pauses (SIGSTOP) and records a gate step when the run crosses its token budget", async () => {
    if (process.platform === "win32") return; // SIGSTOP is POSIX-only; this behavior only applies there
    const proc = new FakeProcess();
    const spawnFn = vi.fn().mockReturnValue(asSpawned(proc));

    await startRun(
      { projectId: "proj-1", agentId: "test-agent", config: { prompt: "x", budgetTokens: 50 } },
      { spawn: spawnFn },
    );
    emitLine(proc, { type: "usage", usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 } });

    await waitUntil(() => state.run?.status === "paused");
    expect(proc.killCalls).toContain("SIGSTOP");
    expect(state.steps.some((s) => s.type === "gate")).toBe(true);
  });
});

describe("applyControl", () => {
  it("cancels an active run: SIGCONT then SIGTERM, escalating to SIGKILL after the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const proc = new FakeProcess();
      const spawnFn = vi.fn().mockReturnValue(asSpawned(proc));
      const { runId } = (await startRun(
        { projectId: "proj-1", agentId: "test-agent", config: { prompt: "x" } },
        { spawn: spawnFn },
      )) as { ok: true; runId: string };

      const result = await applyControl(runId, "cancel");
      expect(result).toEqual({ ok: true });
      expect(proc.killCalls).toEqual(["SIGCONT", "SIGTERM"]);

      await vi.advanceTimersByTimeAsync(5000);
      expect(proc.killCalls).toContain("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a control action the adapter doesn't support", async () => {
    getRunAdapterMock.mockReturnValue(testAdapter({ supportsGating: false }));
    const proc = new FakeProcess();
    const spawnFn = vi.fn().mockReturnValue(asSpawned(proc));
    const { runId } = (await startRun(
      { projectId: "proj-1", agentId: "test-agent", config: { prompt: "x" } },
      { spawn: spawnFn },
    )) as { ok: true; runId: string };

    const result = await applyControl(runId, "step");
    expect(result.ok).toBe(false);
    expect(proc.killCalls).toEqual([]);
  });

  it("rejects control on a run that isn't active", async () => {
    const result = await applyControl("no-such-run", "cancel");
    expect(result).toEqual({ ok: false, reason: "Run is not currently active." });
  });
});
