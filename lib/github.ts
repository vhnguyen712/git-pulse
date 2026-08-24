import { Octokit } from "@octokit/rest";
import { logger } from "./logging";
import { resolveSettings } from "./settings";

/**
 * Server-only GitHub client. The token is resolved from the Settings page
 * (DB) or GITHUB_TOKEN (.env.local) and never leaves the server process —
 * every route in app/api/** proxies through these functions instead of
 * exposing Octokit (or the token) to the browser.
 */
async function getToken(): Promise<string> {
  const { githubToken } = await resolveSettings();
  if (!githubToken) {
    throw new GitHubConfigError(
      "No GitHub token configured. Add one in Settings, or set GITHUB_TOKEN in .env.local.",
    );
  }
  return githubToken;
}

// Cached by the resolved token value so a change made in Settings takes
// effect on the next call, with no explicit cache-bust wiring needed.
let cachedClient: { token: string; client: Octokit } | null = null;

export async function getOctokit(): Promise<Octokit> {
  const token = await getToken();
  if (cachedClient && cachedClient.token === token) return cachedClient.client;
  const client = new Octokit({ auth: token });
  cachedClient = { token, client };
  return client;
}

export class GitHubConfigError extends Error {}

export class GitHubRateLimitError extends Error {
  /** Epoch seconds when the rate limit resets. */
  resetAt: number;
  constructor(resetAt: number) {
    super("GitHub API rate limit exceeded.");
    this.resetAt = resetAt;
  }
}

/** Narrow the shape of octokit errors we care about without depending on internal types. */
function isRateLimitError(err: unknown): err is { status: number; response?: { headers?: Record<string, string> } } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: number }).status === 403
  );
}

async function withRateLimitHandling<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isRateLimitError(err)) {
      const remaining = err.response?.headers?.["x-ratelimit-remaining"];
      const reset = err.response?.headers?.["x-ratelimit-reset"];
      if (remaining === "0" && reset) {
        throw new GitHubRateLimitError(Number(reset));
      }
    }
    logger.error("GitHub API request failed", err);
    throw err;
  }
}

/**
 * Validates a token that hasn't been saved yet — used by the Settings page's
 * "Test connection" so a user can check a freshly-pasted PAT before
 * committing it, instead of only being able to test whatever is already
 * saved. Deliberately bypasses getOctokit()'s cache/settings resolution.
 */
export async function testGithubToken(token: string): Promise<{ login: string }> {
  const octokit = new Octokit({ auth: token });
  return withRateLimitHandling(async () => {
    const { data } = await octokit.users.getAuthenticated();
    return { login: data.login };
  });
}

export interface RepoSummary {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  language: string | null;
  openIssuesCount: number;
  pushedAt: string | null;
}

// The Overview page re-fetches this on every render (force-dynamic); without
// a cache that's a live GitHub call (and, pre-pagination-fix, a capped-at-100
// one) on every visit. Module-level cache is fine for this single-process
// local app — restarting the dev/prod server naturally clears it.
const REPO_CACHE_TTL_MS = 3 * 60_000;
let repoCache: { at: number; data: RepoSummary[] } | null = null;

/** Repos the authenticated user owns or collaborates on, most recently pushed first. */
export async function listRepos(opts: { force?: boolean } = {}): Promise<RepoSummary[]> {
  if (!opts.force && repoCache && Date.now() - repoCache.at < REPO_CACHE_TTL_MS) {
    return repoCache.data;
  }

  const octokit = await getOctokit();
  const data = await withRateLimitHandling(async () => {
    return octokit.paginate(octokit.repos.listForAuthenticatedUser, {
      sort: "pushed",
      per_page: 100,
      affiliation: "owner,collaborator",
    });
  });

  const repos = data.map((r) => ({
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    htmlUrl: r.html_url,
    defaultBranch: r.default_branch,
    language: r.language,
    openIssuesCount: r.open_issues_count ?? 0,
    pushedAt: r.pushed_at,
  }));

  repoCache = { at: Date.now(), data: repos };
  return repos;
}

export interface RepoMeta {
  defaultBranch: string;
  htmlUrl: string;
}

export async function getRepo(owner: string, repo: string): Promise<RepoMeta> {
  const octokit = await getOctokit();
  return withRateLimitHandling(async () => {
    const { data } = await octokit.repos.get({ owner, repo });
    return { defaultBranch: data.default_branch, htmlUrl: data.html_url };
  });
}

/** Current HEAD sha of a single branch — the head end of each sync's compare range. */
export async function getBranchHeadSha(
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const octokit = await getOctokit();
  return withRateLimitHandling(async () => {
    const { data } = await octokit.repos.getBranch({ owner, repo, branch });
    return data.commit.sha;
  });
}

/**
 * All branch names for a repo (unordered). Backs the per-repo branch picker
 * so a user can sync a branch other than the default; the caller decides how
 * to order them (see GET /api/branches, which surfaces the default first).
 */
export async function listBranches(owner: string, repo: string): Promise<string[]> {
  const octokit = await getOctokit();
  return withRateLimitHandling(async () => {
    const branches = await octokit.paginate(octokit.repos.listBranches, {
      owner,
      repo,
      per_page: 100,
    });
    return branches.map((b) => b.name);
  });
}

export interface CompareCommit {
  sha: string;
  message: string;
  authorName: string | null;
  authorDate: string | null;
  isMerge: boolean;
}

export interface CompareFile {
  filename: string;
  status: string; // "added" | "modified" | "removed" | "renamed" | ...
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CompareResult {
  aheadBy: number;
  commits: CompareCommit[];
  files: CompareFile[];
}

/** Changes between two refs. Prefer this over paging /commits — it returns files+patches in one call. */
export async function compare(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<CompareResult> {
  const octokit = await getOctokit();
  return withRateLimitHandling(async () => {
    const { data } = await octokit.repos.compareCommits({
      owner,
      repo,
      base,
      head,
    });
    return {
      aheadBy: data.ahead_by,
      commits: data.commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        authorName: c.commit.author?.name ?? null,
        authorDate: c.commit.author?.date ?? null,
        isMerge: c.parents.length > 1,
      })),
      files: (data.files ?? []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
    };
  });
}

/** Fallback for a repo's first-ever sync (no last_synced_sha to compare from). */
export async function listRecentCommits(
  owner: string,
  repo: string,
  perPage = 30,
): Promise<CompareCommit[]> {
  const octokit = await getOctokit();
  return withRateLimitHandling(async () => {
    const { data } = await octokit.repos.listCommits({
      owner,
      repo,
      per_page: perPage,
    });
    return data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      authorName: c.commit.author?.name ?? null,
      authorDate: c.commit.author?.date ?? null,
      isMerge: c.parents.length > 1,
    }));
  });
}

export async function getReadme(owner: string, repo: string): Promise<string | null> {
  const octokit = await getOctokit();
  try {
    return await withRateLimitHandling(async () => {
      const { data } = await octokit.repos.getReadme({ owner, repo });
      return Buffer.from(data.content, "base64").toString("utf-8");
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { status?: number }).status === 404) {
      return null; // no README — not an error
    }
    throw err;
  }
}

export interface OpenIssueSummary {
  number: number;
  title: string;
}

export async function getOpenIssues(
  owner: string,
  repo: string,
): Promise<OpenIssueSummary[]> {
  const octokit = await getOctokit();
  return withRateLimitHandling(async () => {
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      state: "open",
      per_page: 50,
    });
    // GitHub's issues API also returns PRs; exclude those.
    return data
      .filter((i) => !("pull_request" in i && i.pull_request))
      .map((i) => ({ number: i.number, title: i.title }));
  });
}

export async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<{ number: number; htmlUrl: string }> {
  const octokit = await getOctokit();
  return withRateLimitHandling(async () => {
    const { data } = await octokit.issues.create({ owner, repo, title, body });
    return { number: data.number, htmlUrl: data.html_url };
  });
}
