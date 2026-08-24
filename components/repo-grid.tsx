"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { RepoCardData } from "@/lib/repos";
import { RepoCard } from "@/components/repo-card";

async function syncRepo(
  owner: string,
  name: string,
  branch: string,
): Promise<{ error?: string }> {
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo: name, branch }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body.error ?? `Sync failed (${res.status})` };
    }
    return {};
  } catch {
    return { error: "Network error while syncing." };
  }
}

export function RepoGrid({ repos }: { repos: RepoCardData[] }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Per-repo branch overrides (key = "owner/name"). Absent = use repo.syncBranch.
  const [branchByRepo, setBranchByRepo] = useState<Record<string, string>>({});
  const [, startRefresh] = useTransition();

  const branchFor = (repo: RepoCardData) =>
    branchByRepo[repo.fullName] ?? repo.syncBranch;

  async function handleRefreshList() {
    setRefreshing(true);
    try {
      // Bypasses the repo-list cache (lib/github.ts) so the server render
      // below picks up fresh GitHub data instead of the cached copy.
      await fetch("/api/repos?force=1");
      startRefresh(() => router.refresh());
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSync(owner: string, name: string, branch: string) {
    const key = `${owner}/${name}`;
    setSyncing((s) => new Set(s).add(key));
    setError(null);
    const result = await syncRepo(owner, name, branch);
    setSyncing((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
    if (result.error) {
      setError(`${key}: ${result.error}`);
    } else {
      startRefresh(() => router.refresh());
    }
  }

  async function handleSyncAll() {
    await Promise.all(repos.map((r) => handleSync(r.owner, r.name, branchFor(r))));
  }

  if (repos.length === 0) {
    return (
      <div className="rounded-lg border border-outline-variant p-8 text-center text-sm text-on-surface-variant">
        No repositories found for this GitHub account.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-on-surface-variant">
          {repos.length} repositor{repos.length === 1 ? "y" : "ies"}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefreshList}
            disabled={refreshing}
            title="Re-fetch the repo list from GitHub (bypasses the cache)"
            className="flex items-center gap-1.5 rounded-md border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh list
          </button>
          <button
            onClick={handleSyncAll}
            disabled={syncing.size > 0}
            className="flex items-center gap-1.5 rounded-md border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={syncing.size > 0 ? "size-3.5 animate-spin" : "size-3.5"} />
            Sync all
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-accent-orange/40 bg-accent-orange-bg px-3 py-2 text-xs text-accent-orange">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {repos.map((repo) => (
          <RepoCard
            key={repo.fullName}
            repo={repo}
            syncing={syncing.has(`${repo.owner}/${repo.name}`)}
            branch={branchFor(repo)}
            onBranchChange={(branch) =>
              setBranchByRepo((m) => ({ ...m, [repo.fullName]: branch }))
            }
            onSync={() => handleSync(repo.owner, repo.name, branchFor(repo))}
          />
        ))}
      </div>
    </div>
  );
}
