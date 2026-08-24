"use client";

import Link from "next/link";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { RepoCardData } from "@/lib/repos";
import { timeAgo } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { PulseIndicator } from "@/components/pulse-indicator";
import { BranchSelect } from "@/components/branch-select";
import { cn } from "@/lib/utils";

export function RepoCard({
  repo,
  syncing,
  branch,
  onBranchChange,
  onSync,
}: {
  repo: RepoCardData;
  syncing: boolean;
  branch: string;
  onBranchChange: (branch: string) => void;
  onSync: () => void;
}) {
  const href = `/project/${repo.owner}/${repo.name}`;

  return (
    <div className="group flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface p-3 transition-colors hover:bg-white/[0.03]">
      <div className="flex items-start justify-between gap-2">
        <Link href={href} className="min-w-0">
          <h3 className="truncate font-heading text-sm font-semibold text-on-surface hover:underline">
            {repo.fullName}
          </h3>
        </Link>
        <div className="flex shrink-0 items-center gap-1.5">
          {repo.newItemCount > 0 && (
            <StatusBadge tone="synced" className="shrink-0">
              {repo.newItemCount} new
            </StatusBadge>
          )}
          {repo.hasUnanalyzedChanges && (
            <StatusBadge tone="pending" className="shrink-0">
              unanalyzed changes
            </StatusBadge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
        {repo.language && (
          <span className="rounded-md bg-surface-container px-1.5 py-0.5">
            {repo.language}
          </span>
        )}
        <span>{repo.openIssuesCount} open issues</span>
        <span>pushed {timeAgo(repo.pushedAt)}</span>
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-outline-variant pt-2">
        <div className="flex items-center gap-1.5 text-xs text-on-surface-variant">
          {syncing ? (
            <PulseIndicator state="processing" label="Syncing…" />
          ) : (
            <span>
              {repo.pinned ? `synced ${timeAgo(repo.lastSyncedAt)}` : "not yet analyzed"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <BranchSelect
            owner={repo.owner}
            repo={repo.name}
            value={branch}
            onChange={onBranchChange}
            disabled={syncing}
            align="right"
          />
          <button
            onClick={onSync}
            disabled={syncing}
            className="flex items-center gap-1 rounded-md border border-outline-variant px-2 py-1 text-xs text-on-surface transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3", syncing && "animate-spin")} />
            Sync now
          </button>
          <Link
            href={href}
            className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-on-primary transition-opacity hover:opacity-90"
          >
            View
            <ArrowRight className="size-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}
