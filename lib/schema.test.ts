import { describe, it, expect } from "vitest";
import { analysisSchema, syncRequestSchema, createIssueRequestSchema } from "./schema";

describe("analysisSchema", () => {
  it("accepts a fully populated payload", () => {
    const result = analysisSchema.safeParse({
      summary: {
        key_achievements: ["shipped auth"],
        fixes_and_refactoring: ["fixed bug"],
        architectural_changes: [],
      },
      next_steps: [
        { title: "Add tests", description: "…", priority: "high", type: "feature" },
      ],
      brainstorm_ideas: [
        { title: "Cache repos", category: "performance", rationale: "…" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("defaults missing arrays to empty", () => {
    const result = analysisSchema.safeParse({ summary: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary.key_achievements).toEqual([]);
      expect(result.data.next_steps).toEqual([]);
      expect(result.data.brainstorm_ideas).toEqual([]);
    }
  });

  it("rejects invalid enum values", () => {
    const result = analysisSchema.safeParse({
      summary: {},
      next_steps: [
        { title: "x", description: "y", priority: "urgent", type: "feature" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("normalizes known synonyms for next_steps[].type", () => {
    const result = analysisSchema.safeParse({
      summary: {},
      next_steps: [
        { title: "x", description: "y", priority: "high", type: "enhancement" },
        { title: "x", description: "y", priority: "high", type: "Chore" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.next_steps.map((s) => s.type)).toEqual(["feature", "refactor"]);
    }
  });

  it("normalizes known synonyms for brainstorm_ideas[].category", () => {
    const result = analysisSchema.safeParse({
      summary: {},
      brainstorm_ideas: [{ title: "x", category: "optimization", rationale: "…" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brainstorm_ideas[0].category).toBe("performance");
    }
  });

  it("still rejects a type/category with no known synonym mapping", () => {
    const result = analysisSchema.safeParse({
      summary: {},
      next_steps: [{ title: "x", description: "y", priority: "high", type: "widget" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("syncRequestSchema", () => {
  it("requires non-empty owner and repo", () => {
    expect(syncRequestSchema.safeParse({ owner: "a", repo: "b" }).success).toBe(true);
    expect(syncRequestSchema.safeParse({ owner: "", repo: "b" }).success).toBe(false);
    expect(syncRequestSchema.safeParse({ owner: "a" }).success).toBe(false);
  });
});

describe("createIssueRequestSchema", () => {
  it("requires a non-empty actionItemId", () => {
    expect(createIssueRequestSchema.safeParse({ actionItemId: "x" }).success).toBe(true);
    expect(createIssueRequestSchema.safeParse({ actionItemId: "" }).success).toBe(false);
  });
});
