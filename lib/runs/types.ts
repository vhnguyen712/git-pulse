/**
 * Core types for the instrumented "Run Cockpit" (see docs/build-plan.md). Pure
 * types + the agent-adapter contract — no `node:` or DB imports — so both the
 * client (cockpit UI) and the server (runner) can import from here, and so the
 * per-agent `parseLine` implementations stay unit-testable in isolation.
 */
import type { TokenUsage } from "@/lib/llm";

/** Lifecycle status of a run. Mirrors the `runs.status` enum. */
export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "awaiting_approval"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled";

/** Human-operated control actions on a live run. */
export type ControlAction = "pause" | "resume" | "step" | "inject" | "cancel";

/** Step kinds recorded on a run's timeline. Mirrors the `run_steps.type` enum. */
export type RunStepType =
  | "system"
  | "message"
  | "tool_use"
  | "tool_result"
  | "usage"
  | "gate"
  | "verify"
  | "error";

/**
 * A single event parsed out of an agent CLI's structured output stream. The
 * recorder turns these into persisted `run_steps` rows (assigning `seq`,
 * timestamps, and cost). `parseLine` only ever emits the subset an agent
 * actually prints — never "gate" (control plane) or "verify" (lib/runs/verify).
 */
export interface ParsedEvent {
  type: RunStepType;
  /** Tool name for tool_use/tool_result events. */
  tool?: string;
  /** Skill/subagent name when one was active. */
  skill?: string;
  /** Short human label for the timeline row. */
  title?: string;
  /** Raw event payload, kept for the step detail drawer. */
  payload?: unknown;
  /** Token usage carried by this event (assistant/result events). */
  usage?: TokenUsage;
}

/** Everything needed to launch and shape a run, persisted on `runs.configJson`. */
export interface RunConfig {
  /** The task/instruction handed to the agent. */
  prompt: string;
  model?: string;
  /** Skills the run is allowed to use (agent-specific; empty = agent default). */
  skills?: string[];
  /** Auto-pause once cumulative tokens cross this ceiling. */
  budgetTokens?: number;
  /** Auto-pause once cumulative estimated cost (USD) crosses this ceiling. */
  budgetUsd?: number;
  /** Require per-tool approval before risky tools run (agent-capability gated). */
  gating?: boolean;
  /** Run the programmatic verification stage when the agent finishes. */
  verify?: boolean;
  /** Verification commands; empty falls back to detected package.json scripts. */
  verifyCommands?: string[];
}

/** Base executable + args for an agent, from lib/terminal/agents.ts effectiveAgentCommand(). */
export interface AgentBaseCommand {
  command: string;
  args: string[];
}

/** How a run is actually spawned for a given agent. */
export interface AgentSpawnSpec {
  /** Full argv (after the base command) for the non-interactive/structured run. */
  args: string[];
  /** Optional data to write to the child's stdin (e.g. streaming-JSON input). */
  stdin?: string;
}

/**
 * Per-agent contract that isolates everything agent-specific: how to spawn it in
 * a non-interactive/structured mode, how to turn its output lines into
 * `ParsedEvent`s, and which control features it supports. Adapters live in
 * lib/runs/adapters/*. `parseLine` MUST be pure (line in → events out) so it can
 * be unit-tested against recorded fixtures with no process or I/O.
 */
export interface AgentRunAdapter {
  id: string;
  /** False when the CLI has no machine-readable stream (TUI-only): raw capture, no tokens/cost. */
  supportsStructuredStream: boolean;
  /** True when guidance can be injected mid-run. */
  supportsInjection: boolean;
  /** True when individual tool calls can be gated (approve/deny). */
  supportsGating: boolean;
  /** Build the argv/stdin for a run from the agent's base command and the run config. */
  buildSpawn(base: AgentBaseCommand, config: RunConfig): AgentSpawnSpec;
  /**
   * Parse one raw output line into zero or more timeline events. Returns `[]`
   * for blank/unrecognized/ignored lines. A single line may yield several events
   * (e.g. an assistant message with multiple content blocks plus usage).
   */
  parseLine(line: string): ParsedEvent[];
}
