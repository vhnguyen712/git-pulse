import { describe, it, expect } from "vitest";
import { stripCodeFence, parseAndValidate, LlmOutputError } from "./llm";

const VALID_ANALYSIS = {
  summary: { key_achievements: [], fixes_and_refactoring: [], architectural_changes: [] },
  next_steps: [],
  brainstorm_ideas: [],
};

describe("stripCodeFence", () => {
  it("strips a ```json fence", () => {
    const raw = "```json\n" + JSON.stringify(VALID_ANALYSIS) + "\n```";
    expect(JSON.parse(stripCodeFence(raw))).toEqual(VALID_ANALYSIS);
  });

  it("strips a bare ``` fence", () => {
    const raw = "```\n" + JSON.stringify(VALID_ANALYSIS) + "\n```";
    expect(JSON.parse(stripCodeFence(raw))).toEqual(VALID_ANALYSIS);
  });

  it("passes plain JSON through unchanged", () => {
    const raw = JSON.stringify(VALID_ANALYSIS);
    expect(stripCodeFence(raw)).toBe(raw);
  });
});

describe("parseAndValidate", () => {
  it("accepts fenced valid JSON", () => {
    const raw = "```json\n" + JSON.stringify(VALID_ANALYSIS) + "\n```";
    expect(parseAndValidate(raw)).toEqual(VALID_ANALYSIS);
  });

  it("throws LlmOutputError on malformed JSON", () => {
    expect(() => parseAndValidate("not json")).toThrow(LlmOutputError);
  });

  it("throws LlmOutputError when the schema doesn't match", () => {
    expect(() => parseAndValidate(JSON.stringify({ foo: "bar" }))).toThrow(LlmOutputError);
  });
});
