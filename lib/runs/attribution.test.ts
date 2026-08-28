import { describe, it, expect } from "vitest";
import { attributionByTool, attributionBySkill, stepTypeCounts, type AttributionStep } from "./attribution";

function step(overrides: Partial<AttributionStep> = {}): AttributionStep {
  return { type: "message", ...overrides };
}

describe("attributionByTool", () => {
  it("sums tokens and cost per tool, sorted by tokens descending", () => {
    const steps: AttributionStep[] = [
      step({ type: "tool_use", tool: "Edit", promptTokens: 100, completionTokens: 20, costEstimate: 500 }),
      step({ type: "tool_use", tool: "Bash", promptTokens: 10, completionTokens: 5, costEstimate: 50 }),
      step({ type: "tool_result", tool: "Edit", promptTokens: 0, completionTokens: 0 }),
    ];
    expect(attributionByTool(steps)).toEqual([
      { key: "Edit", tokens: 120, costMicroUsd: 500, count: 2 },
      { key: "Bash", tokens: 15, costMicroUsd: 50, count: 1 },
    ]);
  });

  it("ignores steps with no tool", () => {
    const steps: AttributionStep[] = [step({ type: "message" }), step({ type: "usage" })];
    expect(attributionByTool(steps)).toEqual([]);
  });

  it("leaves costMicroUsd null when no step in the group has a cost estimate", () => {
    const steps: AttributionStep[] = [step({ type: "tool_use", tool: "Edit", promptTokens: 5 })];
    expect(attributionByTool(steps)).toEqual([{ key: "Edit", tokens: 5, costMicroUsd: null, count: 1 }]);
  });
});

describe("attributionBySkill", () => {
  it("groups by skill, ignoring steps with none", () => {
    const steps: AttributionStep[] = [
      step({ type: "tool_use", tool: "Skill", skill: "pdf", promptTokens: 40 }),
      step({ type: "tool_use", tool: "Edit", promptTokens: 10 }),
    ];
    expect(attributionBySkill(steps)).toEqual([{ key: "pdf", tokens: 40, costMicroUsd: null, count: 1 }]);
  });
});

describe("stepTypeCounts", () => {
  it("counts steps per type, always available even with no tools/skills", () => {
    const steps: AttributionStep[] = [
      step({ type: "message" }),
      step({ type: "message" }),
      step({ type: "usage", promptTokens: 10, completionTokens: 2 }),
    ];
    const result = stepTypeCounts(steps);
    expect(result).toContainEqual({ key: "message", tokens: 0, costMicroUsd: null, count: 2 });
    expect(result).toContainEqual({ key: "usage", tokens: 12, costMicroUsd: null, count: 1 });
  });
});
