import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "@/lib/logging";

const execFileAsync = promisify(execFile);

/**
 * Per-session git worktrees for the embedded terminal.
 *
 * Every terminal tab used to run `claude` directly in `project.localPath`, so
 * two tabs open on the same project shared one working tree — one session's
 * `git switch`/checkout or uncommitted edits would clobber the other's. Giving
 * each session its own linked worktree isolates the working directory while
 * still sharing the repo's object store and refs, so the branch a session
 * commits + pushes (`gitpulse/<id>`) is visible from the main clone and the
 * existing push→draft-PR flow keeps working unchanged.
 *
 * Worktrees live in a `.gitpulse-worktrees/` folder beside the repo (outside
 * its working tree, so they never show up as untracked files), one directory
 * per session id.
 */

const WORKTREES_DIRNAME = ".gitpulse-worktrees";

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Absolute path of the repo's top-level working dir, or null if `repoPath`
 * isn't inside a git working tree (bare repos included). */
async function gitTopLevel(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoPath, ["rev-parse", "--show-toplevel"]);
    const top = stdout.trim();
    return top ? path.normalize(top) : null;
  } catch {
    return null;
  }
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  return (await gitTopLevel(repoPath)) !== null;
}

/** Picks a commit to base the worktree on: the project's sync/default branch
 * if it resolves locally, otherwise the main clone's current HEAD. */
async function resolveStartPoint(repoPath: string, preferred?: string | null): Promise<string> {
  if (preferred) {
    try {
      await git(repoPath, ["rev-parse", "--verify", "--quiet", `${preferred}^{commit}`]);
      return preferred;
    } catch {
      // Branch not present locally (e.g. only exists on the remote) — fall through.
    }
  }
  return "HEAD";
}

/** The folder holding this repo's session worktrees (a sibling of the repo). */
function worktreesBaseFor(topLevel: string): string {
  return path.join(path.dirname(topLevel), WORKTREES_DIRNAME);
}

/** Path where a given session's worktree lives, whether or not it exists yet. */
function worktreePathFor(topLevel: string, sessionId: string): string {
  // sessionId is a crypto.randomUUID() — already path-safe, no sanitizing needed.
  return path.join(worktreesBaseFor(topLevel), `${path.basename(topLevel)}-${sessionId}`);
}

/** Whether `wtPath` is a worktree GitPulse created for this repo (i.e. lives in
 * the repo's `.gitpulse-worktrees/` folder) — as opposed to the main working
 * tree or a worktree the user added themselves. The cleanup UI only ever
 * touches managed worktrees. */
function isManagedWorktree(topLevel: string, wtPath: string): boolean {
  const base = path.normalize(worktreesBaseFor(topLevel));
  const parent = path.normalize(path.dirname(wtPath));
  const prefix = `${path.basename(topLevel)}-`;
  return (
    parent.toLowerCase() === base.toLowerCase() &&
    path.basename(wtPath).startsWith(prefix)
  );
}

/** Is `wtPath` currently a registered worktree of `repoPath`? */
async function isRegisteredWorktree(repoPath: string, wtPath: string): Promise<boolean> {
  try {
    const { stdout } = await git(repoPath, ["worktree", "list", "--porcelain"]);
    const target = path.normalize(wtPath).toLowerCase();
    return stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith("worktree "))
      .some((l) => path.normalize(l.slice("worktree ".length)).toLowerCase() === target);
  } catch {
    return false;
  }
}

/**
 * Creates (or recovers) an isolated worktree for one terminal session and
 * returns its absolute path. Returns null if `repoPath` isn't a git repo or
 * the worktree couldn't be created — callers fall back to running in the
 * repo directly, preserving the pre-worktree behavior.
 *
 * The worktree starts on a detached HEAD at the base branch's tip; the seeded
 * prompt has Claude run `git switch -c gitpulse/<id>` from there, so no
 * throwaway session branch is left behind.
 */
export async function createSessionWorktree(
  repoPath: string,
  sessionId: string,
  startRef?: string | null,
): Promise<string | null> {
  const topLevel = await gitTopLevel(repoPath);
  if (!topLevel) return null;

  const wtPath = worktreePathFor(topLevel, sessionId);

  try {
    // Drop admin entries for worktrees whose directories are already gone, so
    // a stale record from a previous run doesn't block re-adding this path.
    await git(repoPath, ["worktree", "prune"]).catch(() => {});

    // Reconnecting after a server restart reuses the same sessionId; if the
    // worktree is still registered, just hand its path back.
    if (await isRegisteredWorktree(repoPath, wtPath)) return wtPath;

    // A leftover directory that git no longer tracks (crash, manual delete of
    // .git admin) would make `worktree add` fail — clear it first.
    if (fs.existsSync(wtPath)) {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const start = await resolveStartPoint(repoPath, startRef);
    await git(repoPath, ["worktree", "add", "--detach", wtPath, start]);
    return wtPath;
  } catch (err) {
    logger.error("Failed to create per-session git worktree; using repo directly", err);
    return null;
  }
}

/**
 * Removes a session's worktree once its `claude` process has exited for good.
 * Uses a non-force remove so git refuses to delete a worktree with
 * uncommitted or untracked changes — abandoned work is kept on disk rather
 * than silently destroyed (the cleanup UI can force-remove it later). The
 * branch/commits a session created live in the shared repo either way.
 */
export async function removeSessionWorktree(repoPath: string, wtPath: string): Promise<void> {
  const result = await removeWorktree(repoPath, wtPath, false);
  if (!result.ok) {
    logger.warn(
      `Kept terminal worktree at ${wtPath} (${result.reason ?? "removal failed"}); ` +
        `remove it from the workspace's Worktrees panel or with ` +
        `\`git worktree remove --force\` once done.`,
    );
  }
}

/** One entry from `git worktree list`, enriched with the bits the cleanup UI
 * needs: whether it's the repo's main tree, whether GitPulse manages it, and
 * whether it has uncommitted/untracked changes that a plain remove would
 * refuse to discard. */
export interface WorktreeInfo {
  path: string;
  head: string | null;
  /** Short branch name, or null when the worktree is on a detached HEAD. */
  branch: string | null;
  isMain: boolean;
  isManaged: boolean;
  dirty: boolean;
  locked: boolean;
}

/** Lists every worktree of `repoPath` (main tree included). Returns [] if
 * `repoPath` isn't a git repo. */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const topLevel = await gitTopLevel(repoPath);
  if (!topLevel) return [];

  await git(repoPath, ["worktree", "prune"]).catch(() => {});

  let stdout: string;
  try {
    ({ stdout } = await git(repoPath, ["worktree", "list", "--porcelain"]));
  } catch {
    return [];
  }

  // Porcelain output is blank-line-separated records; each starts with a
  // `worktree <path>` line, then `HEAD <sha>`, then `branch <ref>` or
  // `detached`, plus optional `bare`/`locked` flags.
  const records = stdout.split(/\r?\n\r?\n/).map((r) => r.trim()).filter(Boolean);
  const infos: WorktreeInfo[] = [];

  for (const record of records) {
    let wtPath: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let locked = false;
    let bare = false;
    for (const line of record.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "locked" || line.startsWith("locked ")) locked = true;
      else if (line === "bare") bare = true;
    }
    if (!wtPath || bare) continue;

    const normalized = path.normalize(wtPath);
    const isMain = normalized.toLowerCase() === topLevel.toLowerCase();
    const isManaged = isManagedWorktree(topLevel, normalized);
    infos.push({
      path: normalized,
      head,
      branch,
      isMain,
      isManaged,
      dirty: isMain ? false : await isWorktreeDirty(normalized),
      locked,
    });
  }
  return infos;
}

/** True if the worktree has staged, unstaged, or untracked changes — the
 * states a non-force `git worktree remove` refuses to throw away. */
async function isWorktreeDirty(wtPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: wtPath,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim().length > 0;
  } catch {
    // Can't stat it — treat as dirty so we don't imply it's safe to drop.
    return true;
  }
}

/**
 * Removes a single worktree. Non-force refuses to discard uncommitted work
 * (git errors); `force` deletes it regardless. Always prunes stale admin
 * records afterward. Never removes the branch itself.
 */
export async function removeWorktree(
  repoPath: string,
  wtPath: string,
  force: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), wtPath];
  try {
    await git(repoPath, args);
    return { ok: true };
  } catch (err) {
    const reason =
      err instanceof Error && "stderr" in err && typeof err.stderr === "string" && err.stderr.trim()
        ? err.stderr.trim().split(/\r?\n/)[0]
        : "uncommitted changes or removal failed";
    return { ok: false, reason };
  } finally {
    await git(repoPath, ["worktree", "prune"]).catch(() => {});
  }
}

/** True if `wtPath` is one GitPulse created for `repoPath` — the cleanup API's
 * guard against removing the main tree or the user's own worktrees. Returns
 * false when `repoPath` isn't a git repo. */
export async function isManagedWorktreePath(repoPath: string, wtPath: string): Promise<boolean> {
  const topLevel = await gitTopLevel(repoPath);
  if (!topLevel) return false;
  return isManagedWorktree(topLevel, path.normalize(wtPath));
}
