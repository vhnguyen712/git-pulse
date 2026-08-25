"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, FolderGit2, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Cleanup control for the per-session git worktrees the embedded terminal
 * creates (lib/terminal/worktree.ts). A terminal abandoned with uncommitted
 * changes leaves its worktree on disk on purpose — this panel lists those
 * leftovers and removes them once the user is done, backed by
 * /api/worktrees. Worktrees with a live terminal, or with uncommitted work,
 * are called out so nothing is dropped by surprise.
 */

interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  locked: boolean;
  inUse: boolean;
}

/** The `<repo>-<sessionId>` folder name is noise; show a short, stable id. */
function shortLabel(wtPath: string): string {
  const name = wtPath.split(/[\\/]/).pop() ?? wtPath;
  const dash = name.lastIndexOf("-");
  const id = dash >= 0 ? name.slice(dash + 1) : name;
  return id.slice(0, 8);
}

export function WorktreesPanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  // Paths a first "Remove" click flagged as dirty — a second click force-removes.
  const [confirmForce, setConfirmForce] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/worktrees?projectId=${encodeURIComponent(projectId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Failed to load worktrees.");
        return;
      }
      setWorktrees(body.worktrees ?? []);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setConfirmForce(new Set());
      void load();
    }
  }

  async function remove(wt: Worktree, force: boolean) {
    setBusyPath(wt.path);
    setError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, path: wt.path, force }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Server refused a clean remove because the tree turned out dirty —
        // arm the force confirmation for this row instead of erroring out.
        if (res.status === 409 && body.dirty && !force) {
          setConfirmForce((prev) => new Set(prev).add(wt.path));
          return;
        }
        setError(body.error ?? "Failed to remove worktree.");
        return;
      }
      setWorktrees((prev) => (prev ? prev.filter((w) => w.path !== wt.path) : prev));
      setConfirmForce((prev) => {
        const next = new Set(prev);
        next.delete(wt.path);
        return next;
      });
    } catch {
      setError("Network error.");
    } finally {
      setBusyPath(null);
    }
  }

  function handleRemoveClick(wt: Worktree) {
    // Dirty trees (known up front, or flagged after a refused clean remove)
    // need an explicit second click before we force-discard the work.
    const needsConfirm = wt.dirty || confirmForce.has(wt.path);
    void remove(wt, needsConfirm);
  }

  const removableCount = worktrees?.filter((w) => !w.inUse).length ?? 0;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        title="Manage leftover terminal worktrees for this project"
        className="flex items-center gap-1.5 rounded-md border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface-variant transition-colors hover:bg-white/5 hover:text-on-surface"
      >
        <FolderGit2 className="size-3.5" />
        Worktrees
        {removableCount > 0 && (
          <span className="rounded-full bg-primary/20 px-1.5 text-[10px] font-medium text-primary">
            {removableCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 w-80 overflow-hidden rounded-md border border-outline-variant bg-surface-container shadow-lg">
          <div className="flex items-center justify-between border-b border-outline-variant px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">
              Terminal worktrees
            </p>
            <button
              type="button"
              onClick={() => load()}
              disabled={loading}
              title="Refresh"
              className="rounded p-0.5 text-on-surface-variant hover:bg-white/5 hover:text-on-surface disabled:opacity-50"
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            </button>
          </div>

          <div className="max-h-72 overflow-auto p-1">
            {loading && !worktrees && (
              <p className="px-2 py-3 text-center text-xs text-on-surface-variant">Loading…</p>
            )}
            {error && (
              <p className="flex items-center gap-1.5 px-2 py-2 text-xs text-accent-orange">
                <AlertTriangle className="size-3 shrink-0" />
                {error}
              </p>
            )}
            {worktrees && worktrees.length === 0 && !loading && (
              <p className="px-2 py-3 text-center text-xs text-on-surface-variant">
                No leftover worktrees. They&apos;re created per terminal tab and cleaned up
                automatically when a session ends cleanly.
              </p>
            )}
            {worktrees?.map((wt) => {
              const busy = busyPath === wt.path;
              const confirming = confirmForce.has(wt.path) || wt.dirty;
              return (
                <div
                  key={wt.path}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-white/[0.03]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-xs text-on-surface">
                        {wt.branch ?? shortLabel(wt.path)}
                      </span>
                      {wt.inUse ? (
                        <span className="shrink-0 rounded bg-accent-green-bg px-1 text-[10px] text-accent-green">
                          in use
                        </span>
                      ) : wt.dirty ? (
                        <span className="shrink-0 rounded bg-accent-orange-bg px-1 text-[10px] text-accent-orange">
                          uncommitted
                        </span>
                      ) : (
                        <span className="shrink-0 rounded bg-white/5 px-1 text-[10px] text-on-surface-variant">
                          clean
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[10px] text-on-surface-variant" title={wt.path}>
                      {wt.head ? `${wt.head} · ` : ""}
                      {shortLabel(wt.path)}
                    </p>
                  </div>

                  {wt.inUse ? (
                    <span className="shrink-0 text-[10px] text-on-surface-variant">
                      close tab first
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleRemoveClick(wt)}
                      disabled={busy}
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] transition-colors disabled:opacity-50",
                        confirming
                          ? "text-accent-orange hover:bg-accent-orange-bg"
                          : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface",
                      )}
                      title={
                        confirming
                          ? "Discard uncommitted changes and remove this worktree"
                          : "Remove this worktree"
                      }
                    >
                      {busy ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Trash2 className="size-3" />
                      )}
                      {confirming ? "Force remove" : "Remove"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
