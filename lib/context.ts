import type { CompareCommit, CompareFile, OpenIssueSummary } from "./github";

/**
 * Turns raw GitHub data into text the LLM can reason about, within a token
 * budget. Pure functions only (no I/O) so this is unit-testable in isolation.
 */

const CHARS_PER_TOKEN = 4; // rough estimate, good enough for budgeting
const TOKEN_BUDGET = 6000; // tier-1 + tier-2 combined budget for a single call
const README_CHAR_LIMIT = 2000;
const MAX_FILES_LISTED = 200;
const MAX_ISSUES_LISTED = 20;
const MAX_PATCH_LINES = 200;
const COMMITS_PER_MAP_CHUNK = 20;
/** Above this commit count, fall back to map-reduce instead of one big call. */
const MAP_REDUCE_THRESHOLD = 40;

const BOT_NAME_PATTERN = /\[bot\]$|-bot$|^dependabot|^renovate|^github-actions$/i;
const GENERATED_PATH_PATTERN =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock)$|\.(min\.js|min\.css|lock)$|(^|\/)(dist|build|\.next|vendor|node_modules)\//;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function isBotCommit(authorName: string | null): boolean {
  if (!authorName) return false;
  return BOT_NAME_PATTERN.test(authorName.trim());
}

export function isGeneratedFile(path: string): boolean {
  return GENERATED_PATH_PATTERN.test(path);
}

export interface FilteredCommits {
  kept: CompareCommit[];
  droppedCount: number;
}

/** Drops merge commits and known bot authors — signal, not noise. */
export function filterCommits(commits: CompareCommit[]): FilteredCommits {
  const kept = commits.filter((c) => !c.isMerge && !isBotCommit(c.authorName));
  return { kept, droppedCount: commits.length - kept.length };
}

function firstLine(message: string): string {
  return message.split("\n")[0]?.trim() ?? "";
}

/** Tier 1: commit messages + changed-file list (cheap, always included). */
export function buildCommitAndFileSummary(
  commits: CompareCommit[],
  files: CompareFile[],
): string {
  const commitLines = commits
    .map((c) => `- ${c.sha.slice(0, 7)} ${firstLine(c.message)}`)
    .join("\n");

  const fileLines = files
    .slice(0, MAX_FILES_LISTED)
    .map((f) => `- ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join("\n");
  const fileOverflow =
    files.length > MAX_FILES_LISTED
      ? `\n… and ${files.length - MAX_FILES_LISTED} more files`
      : "";

  return [
    `## Commits (${commits.length})`,
    commitLines || "(none)",
    "",
    `## Changed files (${files.length})`,
    (fileLines || "(none)") + fileOverflow,
  ].join("\n");
}

/** Tier 2: trimmed diffs, added only while there's budget left. Skips lockfiles/build output. */
export function buildDiffAppendix(files: CompareFile[], budgetTokens: number): string {
  const candidates = files.filter((f) => f.patch && !isGeneratedFile(f.filename));
  const parts: string[] = [];
  let used = 0;

  for (const f of candidates) {
    const lines = (f.patch as string).split("\n").slice(0, MAX_PATCH_LINES);
    const trimmedNote =
      (f.patch as string).split("\n").length > MAX_PATCH_LINES
        ? "\n… (truncated)"
        : "";
    const block = `### ${f.filename}\n\`\`\`diff\n${lines.join("\n")}${trimmedNote}\n\`\`\``;
    const blockTokens = estimateTokens(block);
    if (used + blockTokens > budgetTokens) break;
    parts.push(block);
    used += blockTokens;
  }

  return parts.length ? `## Diffs\n${parts.join("\n\n")}` : "";
}

export function buildReadmeExcerpt(readme: string | null): string {
  if (!readme) return "";
  const excerpt = readme.slice(0, README_CHAR_LIMIT);
  const truncated = readme.length > README_CHAR_LIMIT ? "\n… (truncated)" : "";
  return `## README\n${excerpt}${truncated}`;
}

export function buildOpenIssuesList(issues: OpenIssueSummary[]): string {
  if (issues.length === 0) return "";
  const lines = issues
    .slice(0, MAX_ISSUES_LISTED)
    .map((i) => `- #${i.number} ${i.title}`)
    .join("\n");
  return `## Open issues\n${lines}`;
}

export function chunkCommits(
  commits: CompareCommit[],
  size = COMMITS_PER_MAP_CHUNK,
): CompareCommit[][] {
  const chunks: CompareCommit[][] = [];
  for (let i = 0; i < commits.length; i += size) {
    chunks.push(commits.slice(i, i + size));
  }
  return chunks;
}

export interface RawSyncData {
  commits: CompareCommit[];
  files: CompareFile[];
  readme: string | null;
  openIssues: OpenIssueSummary[];
}

export interface SingleContext {
  mode: "single";
  /** One prompt-ready context string, within TOKEN_BUDGET. */
  text: string;
  droppedCommits: number;
}

export interface MapReduceContext {
  mode: "map-reduce";
  /** Per-batch commit+file text; lib/llm.ts summarizes each, then reduces with readme/issues. */
  chunks: string[];
  readmeAndIssues: string;
  droppedCommits: number;
}

export type BuiltContext = SingleContext | MapReduceContext;

/** Assembles the final LLM-ready context from raw GitHub data, applying the token budget. */
export function buildContext(raw: RawSyncData): BuiltContext {
  const { kept, droppedCount } = filterCommits(raw.commits);
  const readmeAndIssues = [
    buildReadmeExcerpt(raw.readme),
    buildOpenIssuesList(raw.openIssues),
  ]
    .filter(Boolean)
    .join("\n\n");

  if (kept.length > MAP_REDUCE_THRESHOLD) {
    // The Compare API returns an aggregate file list, not a per-commit
    // mapping, so each batch is summarized by commit message only. The
    // aggregate file list is folded into readmeAndIssues so the final
    // reduce step (lib/llm.ts) still sees it alongside per-batch summaries.
    const chunks = chunkCommits(kept).map((batch) =>
      buildCommitAndFileSummary(batch, []),
    );
    const aggregateFiles = buildCommitAndFileSummary([], raw.files).split(
      "\n\n",
    )[1]; // drop the empty "## Commits (0)" section, keep "## Changed files"
    const reduceContext = [aggregateFiles, readmeAndIssues].filter(Boolean).join("\n\n");
    return {
      mode: "map-reduce",
      chunks,
      readmeAndIssues: reduceContext,
      droppedCommits: droppedCount,
    };
  }

  const tier1 = buildCommitAndFileSummary(kept, raw.files);
  const withReadme = [tier1, readmeAndIssues].filter(Boolean).join("\n\n");
  const usedTokens = estimateTokens(withReadme);
  const remainingBudget = TOKEN_BUDGET - usedTokens;

  const diffAppendix =
    remainingBudget > 200 ? buildDiffAppendix(raw.files, remainingBudget) : "";

  const text = [tier1, diffAppendix, readmeAndIssues].filter(Boolean).join("\n\n");
  return { mode: "single", text, droppedCommits: droppedCount };
}
