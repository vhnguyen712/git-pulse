import { describe, it, expect } from "vitest";
import { resolveControl, controlSupported, budgetExceeded, isTerminal } from "./control";
import type { AgentRunAdapter, RunStatus } from "./types";

describe("resolveControl", () => {
  it("allows cancel from any non-terminal status", () => {
    for (const s of ["queued", "running", "paused", "awaiting_approval", "verifying"] as RunStatus[]) {
      expect(resolveControl(s, "cancel")).toEqual({ allowed: true, status: "cancelled" });
    }
  });

  it("rejects all controls once terminal", () => {
    for (const s of ["done", "failed", "cancelled"] as RunStatus[]) {
      expect(resolveControl(s, "cancel").allowed).toBe(false);
      expect(resolveControl(s, "pause").allowed).toBe(false);
      expect(isTerminal(s)).toBe(true);
    }
  });

  it("pauses a running run and resumes a paused one", () => {
    expect(resolveControl("running", "pause")).toEqual({ allowed: true, status: "paused" });
    expect(resolveControl("paused", "resume")).toEqual({ allowed: true, status: "running" });
  });

  it("rejects pausing a run that isn't running", () => {
    expect(resolveControl("paused", "pause").allowed).toBe(false);
    expect(resolveControl("queued", "resume").allowed).toBe(false);
  });

  it("steps from a held state back to running", () => {
    expect(resolveControl("awaiting_approval", "step")).toEqual({ allowed: true, status: "running" });
    expect(resolveControl("running", "step").allowed).toBe(false);
  });

  it("injects without changing status while live", () => {
    expect(resolveControl("running", "inject")).toEqual({ allowed: true });
    expect(resolveControl("done", "inject").allowed).toBe(false);
  });
});

function adapter(caps: Partial<AgentRunAdapter>): AgentRunAdapter {
  return {
    id: "x",
    supportsStructuredStream: false,
    supportsInjection: false,
    supportsGating: false,
    buildSpawn: () => ({ args: [] }),
    parseLine: () => [],
    ...caps,
  };
}

describe("controlSupported", () => {
  it("always allows cancel", () => {
    expect(controlSupported("cancel", adapter({}))).toBe(true);
  });
  it("gates pause/resume on a structured stream", () => {
    expect(controlSupported("pause", adapter({ supportsStructuredStream: true }))).toBe(true);
    expect(controlSupported("pause", adapter({ supportsStructuredStream: false }))).toBe(false);
  });
  it("gates step on gating and inject on injection support", () => {
    expect(controlSupported("step", adapter({ supportsGating: true }))).toBe(true);
    expect(controlSupported("inject", adapter({ supportsInjection: true }))).toBe(true);
    expect(controlSupported("inject", adapter({ supportsInjection: false }))).toBe(false);
  });
});

describe("budgetExceeded", () => {
  it("trips on a token ceiling", () => {
    expect(budgetExceeded({ totalTokens: 1000, costMicroUsd: null }, { budgetTokens: 1000 })).toBe(true);
    expect(budgetExceeded({ totalTokens: 999, costMicroUsd: null }, { budgetTokens: 1000 })).toBe(false);
  });

  it("trips on a USD ceiling (compared in micro-USD)", () => {
    // budgetUsd $0.50 → 500,000 µ$
    expect(budgetExceeded({ totalTokens: 0, costMicroUsd: 500_000 }, { budgetUsd: 0.5 })).toBe(true);
    expect(budgetExceeded({ totalTokens: 0, costMicroUsd: 499_999 }, { budgetUsd: 0.5 })).toBe(false);
  });

  it("ignores a cost budget when cost can't be estimated", () => {
    expect(budgetExceeded({ totalTokens: 0, costMicroUsd: null }, { budgetUsd: 0.5 })).toBe(false);
  });

  it("never trips with no budget configured", () => {
    expect(budgetExceeded({ totalTokens: 1e9, costMicroUsd: 1e9 }, {})).toBe(false);
  });
});
