import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logger } from "@/lib/logging";
import { activeWorktreePaths } from "@/lib/terminal/server";
import {
  isManagedWorktreePath,
  listWorktrees,
  removeWorktree,
} from "@/lib/terminal/worktree";

/**
 * Lists and removes the per-session git worktrees the embedded terminal
 * creates (see lib/terminal/worktree.ts). Abandoning a terminal with
 * uncommitted changes intentionally leaves its worktree on disk so the work
 * isn't lost; this endpoint backs the workspace's "Worktrees" cleanup panel,
 * which lets the user reclaim those once they're done with them.
 *
 * Only GitPulse-managed worktrees are ever touched — never the repo's main
 * working tree or worktrees the user added themselves.
 */

interface WorktreeRow {
  path: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  locked: boolean;
  inUse: boolean;
}

async function loadProject(projectId: string | null) {
  if (!projectId) return null;
  return db.query.projects.findFirst({ where: (p, { eq }) => eq(p.id, projectId) });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = await loadProject(url.searchParams.get("projectId"));
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  if (!project.localPath) {
    // No local clone configured — nothing to manage, but not an error.
    return NextResponse.json({ worktrees: [] });
  }

  try {
    const inUse = activeWorktreePaths();
    const worktrees: WorktreeRow[] = (await listWorktrees(project.localPath))
      .filter((w) => w.isManaged && !w.isMain)
      .map((w) => ({
        path: w.path,
        branch: w.branch,
        head: w.head ? w.head.slice(0, 7) : null,
        dirty: w.dirty,
        locked: w.locked,
        inUse: inUse.has(path.normalize(w.path).toLowerCase()),
      }));
    return NextResponse.json({ worktrees });
  } catch (err) {
    logger.error("GET /api/worktrees failed", err);
    return NextResponse.json({ error: "Failed to list worktrees." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { projectId, path: wtPath, force } = (body ?? {}) as {
    projectId?: unknown;
    path?: unknown;
    force?: unknown;
  };
  if (typeof projectId !== "string" || typeof wtPath !== "string" || !wtPath.trim()) {
    return NextResponse.json({ error: "projectId and path are required." }, { status: 400 });
  }

  const project = await loadProject(projectId);
  if (!project || !project.localPath) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  // Guard: only ever remove a worktree this app created for this repo. Blocks
  // the main working tree and any path outside the repo's managed folder.
  if (!(await isManagedWorktreePath(project.localPath, wtPath))) {
    return NextResponse.json(
      { error: "Refusing to remove a worktree that isn't managed by this app." },
      { status: 400 },
    );
  }

  // Guard: a live session is running `claude` in this worktree.
  if (activeWorktreePaths().has(path.normalize(wtPath).toLowerCase())) {
    return NextResponse.json(
      { error: "That worktree has an open terminal. Close its tab first." },
      { status: 409 },
    );
  }

  try {
    const result = await removeWorktree(project.localPath, wtPath, force === true);
    if (!result.ok) {
      // Non-force remove of a dirty worktree lands here — surface it so the UI
      // can offer a force retry rather than silently failing.
      return NextResponse.json(
        { error: result.reason ?? "Could not remove worktree.", dirty: true },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("DELETE /api/worktrees failed", err);
    return NextResponse.json({ error: "Failed to remove worktree." }, { status: 500 });
  }
}
