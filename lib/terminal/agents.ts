/**
 * Registry of the agentic coding CLIs the embedded terminal can launch. Pure
 * data (no `node:` imports) so both the client (agent picker, session context)
 * and the server (spawn path in lib/terminal/server.ts) can import it.
 *
 * `command` is the default binary name resolved on PATH exactly like `claude`
 * was originally; a user can repoint it per-agent from Settings (see
 * `settings.agentOverrides`), e.g. to an absolute path for a non-standard
 * install.
 */
export interface AgentDefinition {
  id: string;
  /** Human label for the picker and terminal close messages. */
  label: string;
  /** Default executable name (PATH-resolved) or path. */
  command: string;
  /** Default args passed to the CLI on spawn (interactive TUIs take none). */
  args: string[];
  /**
   * A substring the CLI prints once it's finished its async startup (e.g. an
   * auth check) and is ready to read input. When set, the seeded task prompt
   * (see lib/terminal/server.ts) is held back until this marker appears in the
   * CLI's output — writing earlier drops the keystrokes into a not-yet-listening
   * process. `agy` shows "for shortcuts" in its footer only once ready; a plain
   * "output went idle" heuristic misfires on the long quiet gap that occurs
   * *during* its sign-in, so a concrete marker is used instead.
   */
  promptReadySignal?: string;
  /**
   * True if this CLI's input enables bracketed-paste mode (ESC[?2004h) and
   * treats a raw newline as "submit". The seeded multi-line prompt must then
   * be wrapped in bracketed-paste markers so its newlines are inserted as
   * literal content into the input box (staged for the user to review and
   * Enter) instead of submitting each line as it arrives. Verified for agy.
   */
  wrapPromptInBracketedPaste?: boolean;
}

export const AGENTS: Record<string, AgentDefinition> = {
  claude: { id: "claude", label: "Claude Code", command: "claude", args: [] },
  codex: { id: "codex", label: "Codex", command: "codex", args: [] },
  // Antigravity's CLI is `agy` (bare `agy` launches the interactive TUI). It
  // does an async sign-in check on startup, so its prompt must be deferred.
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    command: "agy",
    args: [],
    promptReadySignal: "for shortcuts",
    wrapPromptInBracketedPaste: true,
  },
};

export const DEFAULT_AGENT_ID = "claude";

/** Stable order for the UI picker, default (Claude Code) first. */
export const AGENT_LIST: AgentDefinition[] = Object.values(AGENTS);

/** Resolves an agent id to its definition, falling back to the default. */
export function getAgent(id: string | null | undefined): AgentDefinition {
  return (id && AGENTS[id]) || AGENTS[DEFAULT_AGENT_ID];
}

/** A per-agent command/args override, as stored (JSON) in settings.agentOverrides. */
export interface AgentOverride {
  command?: string;
  args?: string[];
}

export type AgentOverrides = Record<string, AgentOverride>;

/**
 * Effective command + args for an agent: the stored override wins over the
 * registry default, field by field. `command` may be a bare name (PATH-resolved
 * by the caller) or an absolute path.
 */
export function effectiveAgentCommand(
  agent: AgentDefinition,
  override: AgentOverride | undefined,
): { command: string; args: string[] } {
  return {
    command: override?.command?.trim() || agent.command,
    args: override?.args ?? agent.args,
  };
}
