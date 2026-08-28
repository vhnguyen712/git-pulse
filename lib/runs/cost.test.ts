import { describe, it, expect } from "vitest";
import { estimateCostUsd, estimateCostMicroUsd } from "./cost";

const pricing = { costPerMillionInput: "3", costPerMillionOutput: "15" };

describe("estimateCostUsd", () => {
  it("computes input + output cost from per-million pricing", () => {
    // 1,000,000 input @ $3 + 500,000 output @ $15 = 3 + 7.5 = 10.5
    expect(estimateCostUsd(1_000_000, 500_000, pricing)).toBeCloseTo(10.5, 10);
  });

  it("returns null when either price is unconfigured", () => {
    expect(estimateCostUsd(1000, 1000, { costPerMillionInput: null, costPerMillionOutput: "15" })).toBeNull();
    expect(estimateCostUsd(1000, 1000, { costPerMillionInput: "3", costPerMillionOutput: null })).toBeNull();
  });

  it("returns null when either token count is missing", () => {
    expect(estimateCostUsd(null, 1000, pricing)).toBeNull();
    expect(estimateCostUsd(1000, undefined, pricing)).toBeNull();
  });

  it("returns null for non-numeric pricing", () => {
    expect(estimateCostUsd(1000, 1000, { costPerMillionInput: "abc", costPerMillionOutput: "15" })).toBeNull();
  });
});

describe("estimateCostMicroUsd", () => {
  it("expresses the same estimate as rounded integer micro-USD", () => {
    // 100,000 input @ $3 = $0.30; 20,000 output @ $15 = $0.30; total $0.60 → 600,000 µ$
    expect(estimateCostMicroUsd(100_000, 20_000, pricing)).toBe(600_000);
  });

  it("returns null when the estimate is unavailable", () => {
    expect(estimateCostMicroUsd(100, 100, { costPerMillionInput: null, costPerMillionOutput: null })).toBeNull();
  });
});
