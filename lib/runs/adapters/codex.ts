/**
 * Codex run adapter. Runs `codex exec` in JSON mode and parses its event stream.
 *
 * DESIGN TARGET — Codex's JSON event output is experimental and version-varying,
 * so this is a best-effort, tolerant parser to be reconciled against the real
 * schema in the M0 spike (docs/spike-cli-streaming.md). It recognizes the common
 * `{ msg: { type, ... } }` envelope shapes; unknown lines are ignored. Where
 * Codex does not report token usage, the run simply shows steps/duration with no
 * cost meter (the same graceful degradation used elsewhere for proxies that omit
 * usage).
 */
import type { AgentBaseCommand, AgentRunAdapter, AgentSpawnSpec, ParsedEvent, RunConfig } from "@/lib/runs/types";
import type { TokenUsage } from "@/lib/llm";

function snippet(text: string, max = 100): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function usageFrom(u: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  const promptTokens = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
  const completionTokens = Number(u.output_tokens ?? u.completion_tokens ?? 0);
  if (!promptTokens && !completionTokens) return undefined;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export const codexAdapter: AgentRunAdapter = {
  id: "codex",
  supportsStructuredStream: true,
  supportsInjection: false,
  supportsGating: false,

  buildSpawn(base: AgentBaseCommand, config: RunConfig): AgentSpawnSpec {
    const args = [...base.args, "exec", "--json", config.prompt];
    if (config.model) args.push("--model", config.model);
    return { args };
  },

  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (!obj || typeof obj !== "object") return [];

    // Unwrap the common `{ id, msg: {...} }` envelope, falling back to the root.
    const msg = (obj.msg && typeof obj.msg === "object" ? obj.msg : obj) as Record<string, unknown>;
    const kind = typeof msg.type === "string" ? msg.type : undefined;

    if (kind === "agent_message" || kind === "message") {
      const text = msg.message ?? msg.text ?? msg.content;
      if (typeof text === "string" && text.trim()) {
        return [{ type: "message", title: snippet(text), payload: msg }];
      }
      return [];
    }
    if (kind === "tool_call" || kind === "function_call" || kind === "command") {
      const name = msg.name ?? msg.tool ?? msg.command;
      return [
        {
          type: "tool_use",
          tool: typeof name === "string" ? name : undefined,
          title: typeof name === "string" ? name : "tool call",
          payload: msg,
        },
      ];
    }
    if (kind === "tool_result" || kind === "command_output") {
      return [{ type: "tool_result", title: "Tool result", payload: msg }];
    }
    if (kind === "token_count" || kind === "usage") {
      const usage = usageFrom(msg);
      return usage ? [{ type: "usage", title: "Token usage", usage, payload: msg }] : [];
    }
    if (kind === "error") {
      const m = msg.message ?? msg.error;
      return [{ type: "error", title: typeof m === "string" ? snippet(m) : "Error", payload: msg }];
    }
    // Bare `{ message: "..." }` with no recognized type.
    if (typeof obj.message === "string" && obj.message.trim()) {
      return [{ type: "message", title: snippet(obj.message), payload: obj }];
    }
    return [];
  },
};
