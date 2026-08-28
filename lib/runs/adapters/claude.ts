/**
 * Claude Code run adapter. Runs the CLI in non-interactive structured mode and
 * parses its JSONL event stream into timeline events.
 *
 * VERIFIED against a real installed CLI (v2.1.250) — see
 * docs/spike-cli-streaming.md for the full transcript and analysis this is
 * based on. `claude -p <prompt> --output-format stream-json --verbose` emits
 * one JSON object per line:
 *  - `system` events with varying `subtype` (init/status/commands_changed/
 *    task_summary/post_turn_summary/...) — only `init` (session start) and
 *    `post_turn_summary` (a short natural-language turn recap) carry
 *    timeline-worthy content; everything else is internal noise and is
 *    dropped rather than mapped to a misleading step.
 *  - `assistant` messages whose `message.content[]` holds `text` and
 *    `tool_use` blocks. Their embedded `message.usage` is a **mid-stream
 *    snapshot, not the turn's final count** (confirmed: output_tokens was
 *    20 on the assistant event vs. 80 on that same turn's message_delta) —
 *    do not use it for accounting.
 *  - `user` messages carrying `tool_result` blocks (`is_error`, `content`).
 *  - `stream_event` wrappers; only `event.type === "message_delta"` matters
 *    here — its `usage` is the turn's authoritative final, incremental count
 *    (confirmed: summing every turn's message_delta usage across a 2-turn run
 *    matched the terminal result's cumulative usage exactly, field for field).
 *  - a terminal `result` object with cumulative `usage` and `total_cost_usd`
 *    (Claude Code's own computed cost, correctly accounting for prompt-cache
 *    pricing tiers and any sub-model usage — more accurate than GitPulse's
 *    flat per-token-million estimate, but not yet wired through; see the
 *    "known gap" note in the spike doc).
 *
 * Not yet confirmed against a real run: the exact `Skill`/`Task` tool_use
 * input field names used by skillFromToolUse() below (no skill was invoked in
 * either spike transcript) — kept as a documented best-effort heuristic.
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
  // Mid-run injection and per-tool gating both need a live, multi-turn input
  // protocol (streamed stdin turns; a permission-prompt callback for gating)
  // that isn't confirmed against an installed CLI (see the M0 spike note
  // above) and isn't wired in lib/runs/runner.ts. Rather than claim a control
  // the runner can't actually back, both are honestly false for now — pause/
  // resume/cancel work today via OS-level process signals, which don't depend
  // on this protocol. Flip these once injection/gating are actually built.
  supportsInjection: false,
  supportsGating: false,

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
    // Claude Code has its own budget cap, enforced between turns — pass ours
    // through directly rather than relying solely on the external SIGSTOP
    // guard (lib/runs/control.ts), which can only react after the fact.
    if (config.budgetUsd) args.push("--max-budget-usd", String(config.budgetUsd));
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
        if (obj.subtype === "init") {
          const model = typeof obj.model === "string" ? obj.model : undefined;
          return [
            {
              type: "system",
              title: model ? `Session started · ${model}` : "Session started",
              payload: obj,
            },
          ];
        }
        if (obj.subtype === "post_turn_summary" && typeof obj.status_detail === "string" && obj.status_detail) {
          return [{ type: "message", title: snippet(obj.status_detail), payload: obj }];
        }
        // Other subtypes (status, commands_changed, task_summary, ...) are
        // internal state pings with no timeline-worthy content, or (for
        // commands_changed) a multi-KB dump of every loaded skill's
        // description — deliberately dropped rather than stored.
        return [];
      }
      case "assistant": {
        const message = (obj.message ?? {}) as { content?: unknown[] };
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
        // NOTE: message.usage is deliberately NOT read here — it's a
        // mid-stream snapshot, not the turn's final count. See stream_event
        // below for the authoritative source.
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
      case "stream_event": {
        const event = (obj.event ?? {}) as { type?: string; usage?: ClaudeUsage };
        if (event.type !== "message_delta") return [];
        const usage = usageFrom(event.usage);
        return usage ? [{ type: "usage", title: "Token usage", usage, payload: event.usage }] : [];
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
