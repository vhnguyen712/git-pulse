import { describe, it, expect } from "vitest";
import { formatTokens, formatUsd, formatDuration } from "./format";

describe("formatTokens", () => {
  it("groups thousands and appends the unit", () => {
    expect(formatTokens(12345)).toBe("12,345 tok");
    expect(formatTokens(0)).toBe("0 tok");
  });
  it("renders an em dash for null/undefined", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
  });
});

describe("formatUsd", () => {
  it("converts micro-USD to a 4-decimal dollar string", () => {
    expect(formatUsd(600_000)).toBe("$0.6000");
    expect(formatUsd(12_345)).toBe("$0.0123");
  });
  it("renders an em dash for null/undefined", () => {
    expect(formatUsd(null)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("uses ms under a second", () => {
    expect(formatDuration(450)).toBe("450ms");
  });
  it("uses one-decimal seconds under a minute", () => {
    expect(formatDuration(1400)).toBe("1.4s");
    expect(formatDuration(59_900)).toBe("59.9s");
  });
  it("uses minutes + seconds at a minute or more", () => {
    expect(formatDuration(123_000)).toBe("2m 3s");
  });
  it("renders an em dash for null/undefined", () => {
    expect(formatDuration(null)).toBe("—");
  });
});
