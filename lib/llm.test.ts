import { describe, it, expect } from "vitest";
import { stripCodeFence, parseAndValidate, parseOverview, LlmOutputError } from "./llm";

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

describe("parseOverview", () => {
  const VALID_OVERVIEW = {
    tagline: "A thing that does stuff",
    context: "Some background.",
    objective: "Some goal.",
    highlighted_features: [{ name: "Feature", description: "Does a thing." }],
    architecture: { overview: "Layered.", components: [] },
    tech_stack: ["TypeScript"],
  };

  it("accepts valid overview JSON, fenced or not", () => {
    expect(parseOverview(JSON.stringify(VALID_OVERVIEW))).toEqual(VALID_OVERVIEW);
    expect(
      parseOverview("```json\n" + JSON.stringify(VALID_OVERVIEW) + "\n```"),
    ).toEqual(VALID_OVERVIEW);
  });

  it("fills in defaults for missing fields", () => {
    expect(parseOverview("{}")).toEqual({
      tagline: "",
      context: "",
      objective: "",
      highlighted_features: [],
      architecture: { overview: "", components: [] },
      tech_stack: [],
    });
  });

  it("throws LlmOutputError on malformed JSON", () => {
    expect(() => parseOverview("not json")).toThrow(LlmOutputError);
  });

  it("throws LlmOutputError when a field has the wrong type", () => {
    expect(() => parseOverview(JSON.stringify({ tagline: 123 }))).toThrow(LlmOutputError);
  });
});
