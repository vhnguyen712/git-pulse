import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  isBotCommit,
  isGeneratedFile,
  filterCommits,
  buildContext,
  buildCommitAndFileSummary,
  buildDiffAppendix,
} from "./context";
import type { CompareCommit, CompareFile } from "./github";

function commit(overrides: Partial<CompareCommit> = {}): CompareCommit {
  return {
    sha: "abc1234567890",
    message: "feat: add thing",
    authorName: "alice",
    authorDate: "2024-01-01T00:00:00Z",
    isMerge: false,
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("estimates roughly 4 chars per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("isBotCommit", () => {
  it("flags common bot author patterns", () => {
    expect(isBotCommit("dependabot[bot]")).toBe(true);
    expect(isBotCommit("renovate-bot")).toBe(true);
    expect(isBotCommit("dependabot")).toBe(true);
    expect(isBotCommit("github-actions")).toBe(true);
  });

  it("does not flag human authors", () => {
    expect(isBotCommit("Jane Doe")).toBe(false);
    expect(isBotCommit(null)).toBe(false);
  });
});

describe("isGeneratedFile", () => {
  it("flags lockfiles and build output", () => {
    expect(isGeneratedFile("package-lock.json")).toBe(true);
    expect(isGeneratedFile("pnpm-lock.yaml")).toBe(true);
    expect(isGeneratedFile("dist/bundle.js")).toBe(true);
    expect(isGeneratedFile("app.min.js")).toBe(true);
  });

  it("does not flag regular source files", () => {
    expect(isGeneratedFile("lib/context.ts")).toBe(false);
  });
});

describe("filterCommits", () => {
  it("drops merge commits and bot commits, keeps the rest", () => {
    const commits = [
      commit({ sha: "1", isMerge: true }),
      commit({ sha: "2", authorName: "dependabot[bot]" }),
      commit({ sha: "3", authorName: "alice" }),
    ];
    const { kept, droppedCount } = filterCommits(commits);
    expect(kept.map((c) => c.sha)).toEqual(["3"]);
    expect(droppedCount).toBe(2);
  });
});

describe("buildCommitAndFileSummary", () => {
  it("renders commit and file sections", () => {
    const summary = buildCommitAndFileSummary(
      [commit({ sha: "abcdefg1234" })],
      [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 }],
    );
    expect(summary).toContain("## Commits (1)");
    expect(summary).toContain("abcdefg");
    expect(summary).toContain("## Changed files (1)");
    expect(summary).toContain("a.ts");
  });
});

describe("buildDiffAppendix", () => {
  it("skips generated files and respects the token budget", () => {
    const files: CompareFile[] = [
      { filename: "package-lock.json", status: "modified", additions: 1, deletions: 0, patch: "+x" },
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+hello" },
    ];
    const appendix = buildDiffAppendix(files, 1000);
    expect(appendix).toContain("src/a.ts");
    expect(appendix).not.toContain("package-lock.json");
  });

  it("stops adding files once the budget is exhausted", () => {
    const files: CompareFile[] = [
      { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "x".repeat(1000) },
      { filename: "b.ts", status: "modified", additions: 1, deletions: 0, patch: "y".repeat(1000) },
    ];
    const appendix = buildDiffAppendix(files, 1);
    expect(appendix).toBe("");
  });
});

describe("buildContext", () => {
  it("uses single mode for small commit counts", () => {
    const ctx = buildContext({
      commits: [commit()],
      files: [],
      readme: null,
      openIssues: [],
    });
    expect(ctx.mode).toBe("single");
  });

  it("switches to map-reduce above the threshold", () => {
    const commits = Array.from({ length: 41 }, (_, i) => commit({ sha: `sha${i}` }));
    const ctx = buildContext({ commits, files: [], readme: null, openIssues: [] });
    expect(ctx.mode).toBe("map-reduce");
    if (ctx.mode === "map-reduce") {
      expect(ctx.chunks.length).toBeGreaterThan(1);
    }
    expect(ctx.commitsCapped).toBe(false);
  });

  it("caps commits at MAX_COMMITS_ANALYZED and keeps the most recent ones", () => {
    const commits = Array.from({ length: 320 }, (_, i) => commit({ sha: `sha${i}` }));
    const ctx = buildContext({ commits, files: [], readme: null, openIssues: [] });
    expect(ctx.mode).toBe("map-reduce");
    expect(ctx.commitsCapped).toBe(true);
    expect(ctx.droppedCommits).toBe(20);
    if (ctx.mode === "map-reduce") {
      // 300 kept commits should still be present, most-recent (highest index) ones.
      const allText = ctx.chunks.join("\n");
      expect(allText).toContain("sha319");
      expect(allText).not.toContain("sha0\n");
    }
  });
});
