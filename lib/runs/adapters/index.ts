/**
 * Registry of run adapters, keyed by the same agent ids as lib/terminal/agents.ts
 * (`claude` | `codex` | `antigravity`). The interactive terminal and the
 * instrumented runner share the agent registry for base command + Settings
 * overrides; this maps each to its run-mode behavior (spawn args + parser +
 * capabilities).
 */
import type { AgentRunAdapter } from "@/lib/runs/types";
import { claudeAdapter } from "@/lib/runs/adapters/claude";
import { codexAdapter } from "@/lib/runs/adapters/codex";
import { antigravityAdapter } from "@/lib/runs/adapters/antigravity";

export const RUN_ADAPTERS: Record<string, AgentRunAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  antigravity: antigravityAdapter,
};

/** Adapter for an agent id, or undefined when the agent has no run adapter. */
export function getRunAdapter(id: string | null | undefined): AgentRunAdapter | undefined {
  return id ? RUN_ADAPTERS[id] : undefined;
}
