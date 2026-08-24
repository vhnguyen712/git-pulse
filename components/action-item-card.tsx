"use client";

import { CheckCircle2, ExternalLink, SquareTerminal, Upload } from "lucide-react";
import type { ActionItem } from "@/lib/db/schema";
import {
  StatusBadge,
  toneFromCategory,
  toneFromPriority,
} from "@/components/status-badge";
import { cn } from "@/lib/utils";

/**
 * Task prompt for an action item: references the GitHub issue once the item
 * has been pushed, and falls back to the raw suggestion beforehand. Used to
 * pre-fill the embedded terminal panel.
 */
function buildPrompt(item: ActionItem): string {
  const lines: string[] =
    item.githubIssueNumber && item.githubIssueUrl
      ? [
          `Work on GitHub issue #${item.githubIssueNumber}: ${item.title}`,
          ...(item.description ? ["", item.description] : []),
          "",
          `Issue: ${item.githubIssueUrl}`,
        ]
      : [
          `Implement this task: ${item.title}`,
          ...(item.description ? ["", item.description] : []),
        ];
  return lines.join("\n");
}

export function ActionItemCard({
  item,
  pushing,
  error,
  onPush,
  onOpenTerminal,
}: {
  item: ActionItem;
  pushing: boolean;
  error?: string;
  onPush: () => void;
  /** Opens the embedded terminal panel with this item's prompt pre-filled. */
  onOpenTerminal: (prompt: string) => void;
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

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
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

        <button
          onClick={() => onOpenTerminal(buildPrompt(item))}
          title="Open a claude session for this task, embedded right here"
          className="inline-flex items-center gap-1 rounded-md border border-outline-variant px-2 py-1 text-xs text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
        >
          <SquareTerminal className="size-3" />
          Open in Claude Code
        </button>
      </div>
    </div>
  );
}
