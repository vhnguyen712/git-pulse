import { describe, it, expect } from "vitest";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { antigravityAdapter } from "./adapters/antigravity";
import { getRunAdapter } from "./adapters";

describe("claudeAdapter.parseLine", () => {
  it("maps the system/init line to a system step", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", model: "claude-x", tools: [] });
    expect(claudeAdapter.parseLine(line)).toEqual([
      { type: "system", title: "Turn ready · claude-x", payload: expect.any(Object) },
    ]);
  });

  it("splits an assistant message into text and tool_use events, ignoring its stale embedded usage", () => {
    // Fixture shape verified against a real CLI transcript
    // (docs/spike-cli-streaming.md): message.usage on an assistant event is a
    // mid-stream snapshot, not the turn's final count, so it must NOT be
    // surfaced as a usage step here.
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me edit the file." },
          { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "a.ts" }, caller: { type: "direct" } },
        ],
        usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5624, cache_read_input_tokens: 31606 },
      },
    });
    const events = claudeAdapter.parseLine(line);
    expect(events).toEqual([
      { type: "message", title: "Let me edit the file.", payload: expect.any(Object) },
      { type: "tool_use", tool: "Edit", skill: undefined, title: "Edit", payload: { file_path: "a.ts" } },
    ]);
  });

  it("extracts the skill name from a Skill tool_use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "pdf" } }] },
    });
    expect(claudeAdapter.parseLine(line)).toEqual([
      { type: "tool_use", tool: "Skill", skill: "pdf", title: "Skill", payload: { skill: "pdf" } },
    ]);
  });

  it("extracts usage from a stream_event message_delta — the turn's authoritative, incremental count", () => {
    // Fixture shape + values verified against a real CLI transcript: this is
    // the ONLY reliable usage source — confirmed by summing two turns' worth
    // of message_delta usage and matching the terminal result's cumulative
    // usage exactly, field for field.
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 2, output_tokens: 80, cache_creation_input_tokens: 5624, cache_read_input_tokens: 31606 },
      },
    });
    expect(claudeAdapter.parseLine(line)).toEqual([
      {
        type: "usage",
        title: "Token usage",
        usage: { promptTokens: 2 + 5624 + 31606, completionTokens: 80, totalTokens: 2 + 5624 + 31606 + 80 },
        payload: expect.any(Object),
      },
    ]);
  });

  it("ignores other stream_event subtypes (message_start/content_block_*/message_stop)", () => {
    for (const type of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_stop"]) {
      expect(claudeAdapter.parseLine(JSON.stringify({ type: "stream_event", event: { type } }))).toEqual([]);
    }
  });

  it("maps system/init to a session-started step and drops internal-only subtypes", () => {
    expect(
      claudeAdapter.parseLine(JSON.stringify({ type: "system", subtype: "init", model: "claude-x" })),
    ).toEqual([{ type: "system", title: "Turn ready · claude-x", payload: expect.any(Object) }]);

    // status/commands_changed/task_summary carry no timeline-worthy content —
    // commands_changed in particular dumps every loaded skill's full
    // description (multi-KB), which must not be stored per step.
    for (const subtype of ["status", "commands_changed", "task_summary"]) {
      expect(claudeAdapter.parseLine(JSON.stringify({ type: "system", subtype }))).toEqual([]);
    }
  });

  it("maps system/post_turn_summary's status_detail to a message step", () => {
    const line = JSON.stringify({ type: "system", subtype: "post_turn_summary", status_detail: "replied with 'pong'" });
    expect(claudeAdapter.parseLine(line)).toEqual([
      { type: "message", title: "replied with 'pong'", payload: expect.any(Object) },
    ]);
  });

  it("maps a tool_result carried on a user message", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "x", is_error: true }] },
    });
    expect(claudeAdapter.parseLine(line)).toEqual([
      { type: "tool_result", title: "Tool error", payload: expect.any(Object) },
    ]);
  });

  it("marks the terminal result as a completion (not a summed usage event) and flags turnComplete", () => {
    const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 });
    expect(claudeAdapter.parseLine(ok)).toEqual([
      { type: "system", title: "Run complete", payload: expect.any(Object), turnComplete: true },
    ]);
    const bad = JSON.stringify({ type: "result", subtype: "error", is_error: true });
    const badEvents = claudeAdapter.parseLine(bad);
    expect(badEvents[0].type).toBe("error");
    expect(badEvents[0].turnComplete).toBe(true);
  });

  it("formats an interactive spawn (stream-json input) and its user-turn stdin line", () => {
    const spec = claudeAdapter.buildSpawn({ command: "claude", args: [] }, { prompt: "do it", interactive: true });
    expect(spec.args).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(spec.stdin).toBe(`${JSON.stringify({ type: "user", message: { role: "user", content: "do it" } })}\n`);
    expect(claudeAdapter.formatUserTurn?.("more guidance")).toBe(
      `${JSON.stringify({ type: "user", message: { role: "user", content: "more guidance" } })}\n`,
    );
  });

  it("ignores blank and unparseable lines", () => {
    expect(claudeAdapter.parseLine("")).toEqual([]);
    expect(claudeAdapter.parseLine("not json")).toEqual([]);
    expect(claudeAdapter.parseLine(JSON.stringify({ type: "unknown" }))).toEqual([]);
  });
});

describe("codexAdapter.parseLine", () => {
  it("unwraps a { msg } envelope into a message step", () => {
    const line = JSON.stringify({ id: "1", msg: { type: "agent_message", message: "Working on it" } });
    expect(codexAdapter.parseLine(line)).toEqual([
      { type: "message", title: "Working on it", payload: expect.any(Object) },
    ]);
  });

  it("maps a tool/function call and token usage", () => {
    expect(codexAdapter.parseLine(JSON.stringify({ msg: { type: "tool_call", name: "shell" } }))).toEqual([
      { type: "tool_use", tool: "shell", title: "shell", payload: expect.any(Object) },
    ]);
    expect(
      codexAdapter.parseLine(JSON.stringify({ msg: { type: "token_count", input_tokens: 50, output_tokens: 10 } })),
    ).toEqual([
      {
        type: "usage",
        title: "Token usage",
        usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
        payload: expect.any(Object),
      },
    ]);
  });

  it("ignores unrecognized and unparseable lines", () => {
    expect(codexAdapter.parseLine("{}")).toEqual([]);
    expect(codexAdapter.parseLine("garbage")).toEqual([]);
  });
});

describe("antigravityAdapter.parseLine", () => {
  it("captures raw lines as message steps with ANSI stripped", () => {
    const withColor = "[32mhello[0m world";
    expect(antigravityAdapter.parseLine(withColor)).toEqual([
      { type: "message", title: "hello world", payload: { raw: withColor } },
    ]);
  });

  it("drops empty lines", () => {
    expect(antigravityAdapter.parseLine("   ")).toEqual([]);
  });

  it("is not marked as structured/instrumentable", () => {
    expect(antigravityAdapter.supportsStructuredStream).toBe(false);
  });
});

describe("getRunAdapter", () => {
  it("resolves known agents and returns undefined otherwise", () => {
    expect(getRunAdapter("claude")).toBe(claudeAdapter);
    expect(getRunAdapter("codex")).toBe(codexAdapter);
    expect(getRunAdapter("antigravity")).toBe(antigravityAdapter);
    expect(getRunAdapter("nope")).toBeUndefined();
    expect(getRunAdapter(null)).toBeUndefined();
  });
});

describe("buildSpawn", () => {
  it("builds Claude's structured non-interactive argv", () => {
    const spec = claudeAdapter.buildSpawn({ command: "claude", args: [] }, { prompt: "do it", model: "claude-x" });
    expect(spec.args).toEqual([
      "-p",
      "do it",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-x",
    ]);
  });

  it("passes a cost budget through to Claude's own --max-budget-usd flag (confirmed present in --help; not yet exercised functionally)", () => {
    const spec = claudeAdapter.buildSpawn({ command: "claude", args: [] }, { prompt: "do it", budgetUsd: 0.5 });
    expect(spec.args).toContain("--max-budget-usd");
    expect(spec.args[spec.args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
  });

  it("builds Codex's exec --json argv", () => {
    const spec = codexAdapter.buildSpawn({ command: "codex", args: [] }, { prompt: "do it" });
    expect(spec.args).toEqual(["exec", "--json", "do it"]);
  });
});
