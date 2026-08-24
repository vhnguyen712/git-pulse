"use client";

import { CheckCircle2, ExternalLink, Upload } from "lucide-react";
import type { ActionItem } from "@/lib/db/schema";
import {
  StatusBadge,
  toneFromCategory,
  toneFromPriority,
} from "@/components/status-badge";
import { cn } from "@/lib/utils";

export function ActionItemCard({
  item,
  pushing,
  error,
  onPush,
}: {
  item: ActionItem;
  pushing: boolean;
  error?: string;
  onPush: () => void;
}) {
  const canPush = item.status === "suggested" || item.status === "approved";
  const isSynced = item.status === "synced";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-on-surface">{item.title}</h4>
        <div className="flex shrink-0 gap-1">
          {item.category && (
            <StatusBadge tone={toneFromCategory(item.category)}>
              {item.category}
            </StatusBadge>
          )}
          {item.priority && item.source === "next_step" && (
            <StatusBadge tone={toneFromPriority(item.priority)}>
              {item.priority}
            </StatusBadge>
          )}
        </div>
      </div>

      {item.description && (
        <p className="text-xs leading-relaxed text-on-surface-variant">
          {item.description}
        </p>
      )}

      {error && <p className="text-xs text-accent-orange">{error}</p>}

      <div className="mt-1">
        {isSynced && item.githubIssueUrl ? (
          <a
            href={item.githubIssueUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-outline-variant px-2 py-1 text-xs text-accent-green hover:bg-white/5"
          >
            <CheckCircle2 className="size-3" />
            View Issue #{item.githubIssueNumber}
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <button
            onClick={onPush}
            disabled={!canPush || pushing}
            className={cn(
              "inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-on-primary transition-opacity hover:opacity-90",
              (!canPush || pushing) && "cursor-not-allowed opacity-50",
            )}
          >
            <Upload className={cn("size-3", pushing && "animate-pulse")} />
            {pushing ? "Pushing…" : "Push to GitHub Issue"}
          </button>
        )}
      </div>
    </div>
  );
}
