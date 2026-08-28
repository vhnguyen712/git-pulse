import { describe, it, expect } from "vitest";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { antigravityAdapter } from "./adapters/antigravity";
import { getRunAdapter } from "./adapters";

describe("claudeAdapter.parseLine", () => {
  it("maps the system/init line to a system step", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", model: "claude-x", tools: [] });
    expect(claudeAdapter.parseLine(line)).toEqual([
      { type: "system", title: "Session started · claude-x", payload: expect.any(Object) },
    ]);
  });

  it("splits an assistant message into text, tool_use, and usage events", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me edit the file." },
          { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
    const events = claudeAdapter.parseLine(line);
    expect(events).toEqual([
      { type: "message", title: "Let me edit the file.", payload: expect.any(Object) },
      { type: "tool_use", tool: "Edit", skill: undefined, title: "Edit", payload: { file_path: "a.ts" } },
      {
        type: "usage",
        title: "Token usage",
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        payload: { input_tokens: 100, output_tokens: 20 },
      },
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

  it("folds cache tokens into prompt tokens", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 },
      },
    });
    expect(claudeAdapter.parseLine(line)).toEqual([
      {
        type: "usage",
        title: "Token usage",
        usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 },
        payload: expect.any(Object),
      },
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

  it("marks the terminal result as a completion (not a summed usage event)", () => {
    const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 });
    expect(claudeAdapter.parseLine(ok)).toEqual([
      { type: "system", title: "Run complete", payload: expect.any(Object) },
    ]);
    const bad = JSON.stringify({ type: "result", subtype: "error", is_error: true });
    expect(claudeAdapter.parseLine(bad)[0].type).toBe("error");
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

  it("builds Codex's exec --json argv", () => {
    const spec = codexAdapter.buildSpawn({ command: "codex", args: [] }, { prompt: "do it" });
    expect(spec.args).toEqual(["exec", "--json", "do it"]);
  });
});
