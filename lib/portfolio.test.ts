import { describe, it, expect } from "vitest";
import { computeRepoHealth } from "./portfolio";

const NOW = Date.parse("2026-08-27T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp for `n` days before the fixed NOW. */
function daysAgo(n: number): string {
  return new Date(NOW - n * DAY_MS).toISOString();
}

describe("computeRepoHealth", () => {
  it("scores a freshly-pushed project as fully active", () => {
    const h = computeRepoHealth({ pushedAt: daysAgo(0), openItemCount: 0, now: NOW });
    expect(h.score).toBe(100);
    expect(h.band).toBe("active");
    expect(h.reason).toBe("pushed today");
  });

  it("keeps anything within the fresh window at 100", () => {
    expect(computeRepoHealth({ pushedAt: daysAgo(7), openItemCount: 0, now: NOW }).score).toBe(100);
  });

  it("decays linearly between the fresh and cold thresholds", () => {
    const h = computeRepoHealth({ pushedAt: daysAgo(30), openItemCount: 0, now: NOW });
    expect(h.band).toBe("cooling");
    expect(h.score).toBeGreaterThan(34);
    expect(h.score).toBeLessThan(67);
    expect(h.reason).toBe("no commits in 30 days");
  });

  it("bottoms out at 0 once past the cold threshold", () => {
    expect(computeRepoHealth({ pushedAt: daysAgo(60), openItemCount: 0, now: NOW })).toMatchObject({
      score: 0,
      band: "cold",
    });
    expect(computeRepoHealth({ pushedAt: daysAgo(120), openItemCount: 0, now: NOW }).score).toBe(0);
  });

  it("treats a missing push time as cold with a clear reason", () => {
    const h = computeRepoHealth({ pushedAt: null, openItemCount: 0, now: NOW });
    expect(h).toMatchObject({ score: 0, band: "cold" });
    expect(h.reason).toBe("no push activity recorded");
  });

  it("appends an open-suggestions count to the reason, pluralized", () => {
    expect(computeRepoHealth({ pushedAt: daysAgo(90), openItemCount: 1, now: NOW }).reason).toBe(
      "no commits in 90 days · 1 open suggestion",
    );
    expect(computeRepoHealth({ pushedAt: daysAgo(90), openItemCount: 3, now: NOW }).reason).toBe(
      "no commits in 90 days · 3 open suggestions",
    );
  });

  it("orders bands so coldest projects sort first by score", () => {
    const scores = [5, 45, 90].map(
      (d) => computeRepoHealth({ pushedAt: daysAgo(d), openItemCount: 0, now: NOW }).score,
    );
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });
});
