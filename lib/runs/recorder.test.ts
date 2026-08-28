import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  insertMock,
  updateMock,
  valuesMock,
  insertReturningMock,
  setMock,
  whereMock,
  updateReturningMock,
  runsFindFirstMock,
} = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  valuesMock: vi.fn(),
  insertReturningMock: vi.fn(),
  setMock: vi.fn(),
  whereMock: vi.fn(),
  updateReturningMock: vi.fn(),
  runsFindFirstMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { insert: insertMock, update: updateMock, query: { runs: { findFirst: runsFindFirstMock } } },
}));

const {
  registerRun,
  unregisterRun,
  activeRunWorktreePaths,
  subscribeRun,
  recordStep,
  setRunStatus,
} = await import("./recorder");

const pricing = { costPerMillionInput: "3", costPerMillionOutput: "15" };

function stepRow(overrides: Record<string, unknown> = {}) {
  return { id: "step-1", runId: "run-1", seq: 0, type: "message", ...overrides };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "running",
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    costEstimate: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertMock.mockReturnValue({ values: valuesMock });
  valuesMock.mockReturnValue({ returning: insertReturningMock });
  insertReturningMock.mockResolvedValue([stepRow()]);

  updateMock.mockReturnValue({ set: setMock });
  setMock.mockReturnValue({ where: whereMock });
  whereMock.mockReturnValue({ returning: updateReturningMock });
  updateReturningMock.mockResolvedValue([runRow()]);

  // Default "current run" state for the read-modify-write rollup, before any usage.
  runsFindFirstMock.mockResolvedValue(runRow());
});

describe("recordStep", () => {
  it("persists a step and does not touch the run row when there's no usage", async () => {
    registerRun("run-1", "/wt/run-1");
    const { step, run } = await recordStep("run-1", { type: "message", title: "hi" }, pricing);
    expect(step).toEqual(stepRow());
    expect(run).toBeNull();
    expect(insertMock).toHaveBeenCalledOnce();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("assigns increasing seq numbers per run from the in-memory counter", async () => {
    registerRun("run-1", null);
    await recordStep("run-1", { type: "message", title: "a" }, pricing);
    await recordStep("run-1", { type: "message", title: "b" }, pricing);
    const firstRow = valuesMock.mock.calls[0][0];
    const secondRow = valuesMock.mock.calls[1][0];
    expect(firstRow.seq).toBe(0);
    expect(secondRow.seq).toBe(1);
  });

  it("adds this event's usage on top of the run's current totals (read-modify-write)", async () => {
    registerRun("run-1", null);
    runsFindFirstMock.mockResolvedValueOnce(
      runRow({ promptTokens: 100, completionTokens: 20, totalTokens: 120, costEstimate: 500 }),
    );
    updateReturningMock.mockResolvedValueOnce([
      runRow({ promptTokens: 150, completionTokens: 25, totalTokens: 175, costEstimate: 650 }),
    ]);

    const { run } = await recordStep(
      "run-1",
      { type: "usage", usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 } },
      pricing,
    );

    expect(runsFindFirstMock).toHaveBeenCalledOnce();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 150, completionTokens: 25, totalTokens: 175 }),
    );
    expect(run).toEqual(runRow({ promptTokens: 150, completionTokens: 25, totalTokens: 175, costEstimate: 650 }));
  });

  it("starts from zero when the run has no prior usage recorded", async () => {
    registerRun("run-1", null);
    runsFindFirstMock.mockResolvedValueOnce(runRow()); // all-null totals
    await recordStep(
      "run-1",
      { type: "usage", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
      pricing,
    );
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 100, completionTokens: 20, totalTokens: 120 }),
    );
  });

  it("skips the run-row update when the run no longer exists", async () => {
    registerRun("run-1", null);
    runsFindFirstMock.mockResolvedValueOnce(undefined);
    const { run } = await recordStep(
      "run-1",
      { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      pricing,
    );
    expect(run).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("computes a step's cost estimate from usage and configured pricing", async () => {
    registerRun("run-1", null);
    await recordStep(
      "run-1",
      { type: "usage", usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 } },
      pricing,
    );
    const insertedRow = valuesMock.mock.calls[0][0];
    expect(insertedRow.costEstimate).toBe(3_000_000); // 1M input @ $3/M = $3 = 3,000,000 µ$
  });

  it("still persists a step for a run with no registered runtime (falls back to seq 0)", async () => {
    const { step } = await recordStep("unregistered-run", { type: "message", title: "x" }, pricing);
    expect(step).toEqual(stepRow());
    const insertedRow = valuesMock.mock.calls[0][0];
    expect(insertedRow.seq).toBe(0);
  });
});

describe("subscribeRun / broadcast", () => {
  it("delivers step and status events only to subscribers of that run", async () => {
    registerRun("run-1", null);
    registerRun("run-2", null);
    const events: string[] = [];
    subscribeRun("run-1", (e) => events.push(e.type));

    await recordStep("run-1", { type: "message", title: "a" }, pricing);
    await recordStep(
      "run-1",
      { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      pricing,
    );
    await recordStep("run-2", { type: "message", title: "b" }, pricing);

    expect(events).toEqual(["step", "step", "status"]);
  });

  it("stops delivering events after unsubscribe", async () => {
    registerRun("run-1", null);
    const events: string[] = [];
    const unsubscribe = subscribeRun("run-1", (e) => events.push(e.type));
    await recordStep("run-1", { type: "message", title: "a" }, pricing);
    unsubscribe();
    await recordStep("run-1", { type: "message", title: "b" }, pricing);
    expect(events).toEqual(["step"]);
  });

  it("is a no-op when subscribing to an unregistered run", () => {
    expect(() => subscribeRun("ghost", () => {})).not.toThrow();
  });
});

describe("activeRunWorktreePaths", () => {
  it("returns normalized, lowercased paths for registered runs with a worktree", () => {
    registerRun("run-1", "/Work/Tree-A");
    registerRun("run-2", null); // no worktree — excluded
    expect(activeRunWorktreePaths()).toEqual(new Set(["/work/tree-a"]));
  });

  it("drops a run's path once unregistered", () => {
    registerRun("run-1", "/wt/a");
    unregisterRun("run-1");
    expect(activeRunWorktreePaths()).toEqual(new Set());
  });
});

describe("setRunStatus", () => {
  it("updates status plus any extra fields and broadcasts", async () => {
    registerRun("run-1", null);
    updateReturningMock.mockResolvedValueOnce([runRow({ status: "done", verifyPassed: true })]);
    const events: string[] = [];
    subscribeRun("run-1", (e) => events.push(e.type));

    const run = await setRunStatus("run-1", "done", { verifyPassed: true });
    expect(run).toEqual(runRow({ status: "done", verifyPassed: true }));
    expect(events).toEqual(["status"]);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "done", verifyPassed: true }),
    );
  });
});
