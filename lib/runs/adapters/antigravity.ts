/**
 * Antigravity (`agy`) run adapter. Antigravity is an interactive TUI with no
 * machine-readable output stream, so it cannot be fully instrumented: runs using
 * it are captured as raw message steps with NO token/cost meter
 * (`supportsStructuredStream: false` → the runner marks the run `instrumented:
 * false`). This keeps "all three agents" honest without pretending to measure
 * what the CLI doesn't emit. Prefer Claude Code or Codex for instrumented runs.
 */
import type { AgentBaseCommand, AgentRunAdapter, AgentSpawnSpec, ParsedEvent } from "@/lib/runs/types";

// Strip ANSI/VT (CSI) control sequences from TUI output so raw-captured lines
// are readable in the timeline: ESC "[" ... <final byte @-~>.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export const antigravityAdapter: AgentRunAdapter = {
  id: "antigravity",
  supportsStructuredStream: false,
  supportsInjection: false,
  supportsGating: false,

  buildSpawn(base: AgentBaseCommand): AgentSpawnSpec {
    return { args: [...base.args] };
  },

  parseLine(line: string): ParsedEvent[] {
    const clean = stripAnsi(line).trimEnd();
    if (!clean.trim()) return [];
    return [{ type: "message", title: clean, payload: { raw: line } }];
  },
};
