"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Per-repo branch picker. Shows the currently selected branch and, when
 * opened, lazily fetches the repo's full branch list from GET /api/branches
 * (so a page full of these doesn't make one GitHub call per repo up front).
 * The default branch comes back first. Purely local state — the choice is
 * only persisted server-side when the user actually syncs.
 */
export function BranchSelect({
  owner,
  repo,
  value,
  onChange,
  disabled,
  align = "left",
  className,
}: {
  owner: string;
  repo: string;
  value: string;
  onChange: (branch: string) => void;
  disabled?: boolean;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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

  async function loadBranches() {
    if (branches || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Failed to load branches.");
        return;
      }
      setBranches(body.branches ?? []);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void loadBranches();
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        title={`Sync branch: ${value}`}
        className="flex max-w-[11rem] items-center gap-1 rounded-md border border-outline-variant px-2 py-1 text-xs text-on-surface-variant transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <GitBranch className="size-3 shrink-0" />
        <span className="truncate">{value}</span>
        <ChevronDown className="size-3 shrink-0 opacity-70" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-20 mt-1 max-h-64 w-56 overflow-auto rounded-md border border-outline-variant bg-surface-container p-1 shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {loading && (
            <p className="px-2 py-1.5 text-xs text-on-surface-variant">Loading branches…</p>
          )}
          {error && (
            <p className="px-2 py-1.5 text-xs text-accent-orange">{error}</p>
          )}
          {branches && branches.length === 0 && !loading && (
            <p className="px-2 py-1.5 text-xs text-on-surface-variant">No branches found.</p>
          )}
          {branches?.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => {
                onChange(b);
                setOpen(false);
              }}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-on-surface transition-colors hover:bg-white/5"
            >
              <Check className={cn("size-3 shrink-0", b === value ? "opacity-100" : "opacity-0")} />
              <span className="truncate">{b}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
