/**
 * Claude Code run adapter. Runs the CLI in non-interactive structured mode and
 * parses its JSONL event stream into timeline events.
 *
 * DESIGN TARGET — confirm the exact flags and event schema in the M0 spike
 * (docs/spike-cli-streaming.md) against the installed CLI before relying on this
 * in production. Modeled on `claude -p --output-format stream-json --verbose`,
 * which emits one JSON object per line: a `system`/init header, `assistant`
 * messages whose `message.content[]` holds text and `tool_use` blocks (with a
 * per-turn `message.usage`), `user` messages carrying `tool_result` blocks, and
 * a terminal `result` object with cumulative usage + `total_cost_usd`.
 *
 * Usage accounting: only the per-turn `assistant` usage is emitted as a `usage`
 * event (the recorder sums those for per-step attribution). The terminal
 * `result` is emitted as a non-usage `system` event so its cumulative totals are
 * not double-counted; the recorder may reconcile against it separately.
 */
import type { AgentBaseCommand, AgentRunAdapter, AgentSpawnSpec, ParsedEvent, RunConfig } from "@/lib/runs/types";
import type { TokenUsage } from "@/lib/llm";

function snippet(text: string, max = 100): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function usageFrom(u: ClaudeUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  const promptTokens =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  const completionTokens = u.output_tokens ?? 0;
  if (promptTokens === 0 && completionTokens === 0) return undefined;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** A skill/subagent invocation surfaces as a specific tool call; pull its name out. */
function skillFromToolUse(name: string, input: unknown): string | undefined {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (name === "Skill") {
    const s = obj.skill ?? obj.command ?? obj.name;
    return typeof s === "string" ? s : undefined;
  }
  if (name === "Task") {
    const s = obj.subagent_type ?? obj.agent;
    return typeof s === "string" ? s : undefined;
  }
  return undefined;
}

export const claudeAdapter: AgentRunAdapter = {
  id: "claude",
  supportsStructuredStream: true,
  supportsInjection: true,
  supportsGating: true,

  buildSpawn(base: AgentBaseCommand, config: RunConfig): AgentSpawnSpec {
    const args = [
      ...base.args,
      "-p",
      config.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
    ];
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

    switch (obj.type) {
      case "system": {
        const model = typeof obj.model === "string" ? obj.model : undefined;
        return [
          {
            type: "system",
            title: model ? `Session started · ${model}` : "Session started",
            payload: obj,
          },
        ];
      }
      case "assistant": {
        const message = (obj.message ?? {}) as { content?: unknown[]; usage?: ClaudeUsage };
        const events: ParsedEvent[] = [];
        for (const raw of message.content ?? []) {
          const block = raw as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") {
            if (block.text.trim()) {
              events.push({ type: "message", title: snippet(block.text), payload: block });
            }
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            events.push({
              type: "tool_use",
              tool: block.name,
              skill: skillFromToolUse(block.name, block.input),
              title: block.name,
              payload: block.input ?? block,
            });
          }
        }
        const usage = usageFrom(message.usage);
        if (usage) events.push({ type: "usage", title: "Token usage", usage, payload: message.usage });
        return events;
      }
      case "user": {
        const message = (obj.message ?? {}) as { content?: unknown[] };
        const events: ParsedEvent[] = [];
        for (const raw of message.content ?? []) {
          const block = raw as Record<string, unknown>;
          if (block.type === "tool_result") {
            events.push({
              type: "tool_result",
              title: block.is_error ? "Tool error" : "Tool result",
              payload: block,
            });
          }
        }
        return events;
      }
      case "result": {
        const isError = obj.is_error === true || obj.subtype === "error";
        return [
          {
            type: isError ? "error" : "system",
            title: isError ? "Run failed" : "Run complete",
            payload: obj,
          },
        ];
      }
      default:
        return [];
    }
  },
};
