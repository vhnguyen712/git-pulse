/**
 * Pure control-plane logic for a run: which human control actions are valid in a
 * given state, what status they move the run to, and whether a budget ceiling
 * has been crossed. Kept free of process/DB concerns so the state machine is
 * unit-tested in isolation; lib/runs/runner.ts wires these decisions to the
 * actual child process and persistence.
 */
import type { AgentRunAdapter, ControlAction, RunConfig, RunStatus } from "@/lib/runs/types";

/** Statuses from which a run can no longer be controlled. */
const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "cancelled"]);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

export interface ControlDecision {
  allowed: boolean;
  /** The status the run moves to when allowed; omitted when status is unchanged (e.g. inject). */
  status?: RunStatus;
  /** Why a disallowed action was rejected, for the API/UI. */
  reason?: string;
}

/**
 * Resolve a control action against the current status. Does not consider agent
 * capability (see `controlSupported`) — only whether the transition is legal.
 */
export function resolveControl(current: RunStatus, action: ControlAction): ControlDecision {
  if (isTerminal(current)) {
    return { allowed: false, reason: `Run is ${current}; no further control is possible.` };
  }
  switch (action) {
    case "cancel":
      return { allowed: true, status: "cancelled" };
    case "pause":
      return current === "running" || current === "awaiting_approval"
        ? { allowed: true, status: "paused" }
        : { allowed: false, reason: `Cannot pause a ${current} run.` };
    case "resume":
      return current === "paused" || current === "awaiting_approval"
        ? { allowed: true, status: "running" }
        : { allowed: false, reason: `Cannot resume a ${current} run.` };
    case "step":
      // Advance one gated step: from a held state back to running.
      return current === "paused" || current === "awaiting_approval"
        ? { allowed: true, status: "running" }
        : { allowed: false, reason: `Cannot step a ${current} run.` };
    case "inject":
      // Steer the agent without changing status; only meaningful while live.
      return current === "running" || current === "paused"
        ? { allowed: true }
        : { allowed: false, reason: `Cannot inject guidance into a ${current} run.` };
    default:
      return { allowed: false, reason: "Unknown control action." };
  }
}

/**
 * Whether a given control is supported for the agent running this run. `cancel`
 * and the budget guard are always available (server-side); the rest depend on
 * the adapter's capabilities.
 */
export function controlSupported(action: ControlAction, adapter: AgentRunAdapter): boolean {
  switch (action) {
    case "cancel":
      return true;
    case "pause":
    case "resume":
      return adapter.supportsStructuredStream;
    case "step":
      return adapter.supportsGating;
    case "inject":
      return adapter.supportsInjection;
    default:
      return false;
  }
}

export interface BudgetRollup {
  totalTokens: number;
  /** Cumulative estimated cost in micro-USD, or null when cost can't be estimated. */
  costMicroUsd: number | null;
}

/**
 * True when a run has reached or crossed a configured budget ceiling and should
 * auto-pause. Always available regardless of agent (computed from the recorder's
 * rollups). A budget that isn't set never triggers; a cost budget is ignored
 * when cost can't be estimated.
 */
export function budgetExceeded(
  rollup: BudgetRollup,
  config: Pick<RunConfig, "budgetTokens" | "budgetUsd">,
): boolean {
  if (config.budgetTokens != null && rollup.totalTokens >= config.budgetTokens) return true;
  if (
    config.budgetUsd != null &&
    rollup.costMicroUsd != null &&
    rollup.costMicroUsd >= config.budgetUsd * 1_000_000
  ) {
    return true;
  }
  return false;
}
