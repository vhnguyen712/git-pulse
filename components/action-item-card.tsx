"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitPullRequest,
  SquareTerminal,
  Trash2,
  Upload,
} from "lucide-react";
import type { ActionItem } from "@/lib/db/schema";
import type { ConflictInfo } from "@/lib/pulls";
import {
  StatusBadge,
  toneFromCategory,
  toneFromPriority,
} from "@/components/status-badge";
import { branchNameForItem } from "@/lib/pull-branch";
import { AGENT_LIST, DEFAULT_AGENT_ID, getAgent } from "@/lib/terminal/agents";
import { cn } from "@/lib/utils";

/**
 * Task prompt for an action item: references the GitHub issue once the item
 * has been pushed, and falls back to the raw suggestion beforehand. Ends
 * with instructions to push a `gitpulse/<id>` branch — GitPulse (not Claude)
 * opens the draft PR from that branch once it's pushed, via its own GitHub
 * token, so no `gh` CLI/auth is required in the target repo. Used to
 * pre-fill the embedded terminal panel; the user still has to press Enter to
 * actually start the agent CLI (see lib/terminal/server.ts) — this only seeds text.
 */
function buildPrompt(item: ActionItem, baseBranch: string): string {
  const task: string[] =
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

  const branch = branchNameForItem(item.id);
  const wrapUp = [
    "",
    "When the implementation is complete:",
    `1. Create a branch named exactly "${branch}": git switch -c ${branch}`,
    `2. Commit your changes and push it: git push -u origin ${branch}`,
    `Do NOT open the pull request yourself — GitPulse will open a draft PR against "${baseBranch}" for review once it sees the branch pushed.`,
    ...(item.githubIssueNumber
      ? [`The PR GitPulse opens will reference "Closes #${item.githubIssueNumber}".`]
      : []),
  ];

  return [...task, ...wrapUp].join("\n");
}

/**
 * Task prompt for resolving a merge conflict: the seeded terminal's worktree
 * is already checked out on the item's existing `gitpulse/<id>` branch (see
 * lib/terminal/server.ts's `startRef` handling), so this just walks the
 * agent through merging the base branch in, resolving conflicts, and pushing
 * back onto the same branch — no raw git knowledge required from the user.
 */
function buildConflictPrompt(item: ActionItem, conflict: ConflictInfo): string {
  return [
    `The pull request for "${item.title}" has a merge conflict with "${conflict.baseBranch}": ${conflict.prUrl}`,
    "",
    `You're already in a worktree on the "${conflict.branch}" branch. To resolve it:`,
    `1. Fetch and merge the base branch: git fetch origin ${conflict.baseBranch} && git merge origin/${conflict.baseBranch}`,
    "2. Resolve every conflicted file, then stage each one with git add.",
    "3. Commit the merge and push it back: git commit && git push",
    "",
    "Do not force-push or rewrite history — just resolve the conflicts and merge normally.",
  ].join("\n");
}

export function ActionItemCard({
  item,
  pushing,
  error,
  baseBranch,
  conflict,
  onPush,
  onOpenTerminal,
  onRemove,
  removing,
}: {
  item: ActionItem;
  pushing: boolean;
  error?: string;
  /** Repo's default branch — the base the seeded prompt tells Claude's PR will target. */
  baseBranch: string;
  /** Set when this item's PR has a merge conflict against the base branch. */
  conflict?: ConflictInfo;
  onPush: () => void;
  /** Opens the embedded terminal panel with this item's prompt pre-filled, running the given agent CLI.
   * `startRef`, when passed, resumes that existing branch instead of starting a new one. */
  onOpenTerminal: (prompt: string, title: string, agentId: string, startRef?: string) => void;
  /** Permanently deletes this action item. Omit to hide the Remove button. */
  onRemove?: () => void;
  removing?: boolean;
}) {
  const canPush = item.status === "suggested" || item.status === "approved";
  const isSynced = item.status === "synced" || item.status === "shipped";
  const [pickerOpen, setPickerOpen] = useState(false);
  // Two-step inline confirm for the destructive Remove, replacing a native
  // window.confirm() — keeps the guard but stays inside the app's own visual
  // language instead of popping an OS dialog.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

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

      {conflict && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent-orange/30 bg-accent-orange-bg px-2 py-1.5">
          <p className="flex items-center gap-1.5 text-xs text-accent-orange">
            <AlertTriangle className="size-3 shrink-0" />
            Merge conflict with {conflict.baseBranch}
          </p>
          <button
            onClick={() =>
              onOpenTerminal(
                buildConflictPrompt(item, conflict),
                `Fix conflict: ${item.title}`,
                DEFAULT_AGENT_ID,
                conflict.branch,
              )
            }
            title={`Open a ${getAgent(DEFAULT_AGENT_ID).label} session already on "${conflict.branch}" to resolve the conflict`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent-orange/40 px-2 py-1 text-xs font-medium text-accent-orange hover:bg-white/5"
          >
            <SquareTerminal className="size-3" />
            Resolve with {getAgent(DEFAULT_AGENT_ID).label}
          </button>
        </div>
      )}

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

        <div className="relative inline-flex">
          <button
            onClick={() => onOpenTerminal(buildPrompt(item, baseBranch), item.title, DEFAULT_AGENT_ID)}
            title={`Open a ${getAgent(DEFAULT_AGENT_ID).label} session for this task, embedded right here`}
            className="inline-flex items-center gap-1 rounded-l-md rounded-r-none border border-outline-variant px-2 py-1 text-xs text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
          >
            <SquareTerminal className="size-3" />
            Open in {getAgent(DEFAULT_AGENT_ID).label}
          </button>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            title="Choose a different agent"
            className="inline-flex items-center rounded-r-md rounded-l-none border border-l-0 border-outline-variant px-1 py-1 text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
          >
            <ChevronDown className="size-3" />
          </button>
          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setPickerOpen(false)} />
              <div className="absolute bottom-full left-0 z-20 mb-1 w-40 overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest shadow-lg">
                {AGENT_LIST.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => {
                      setPickerOpen(false);
                      onOpenTerminal(buildPrompt(item, baseBranch), item.title, agent.id);
                    }}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-on-surface hover:bg-white/5"
                  >
                    <SquareTerminal className="size-3 shrink-0" />
                    Open in {agent.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {item.githubPrUrl && (
          <a
            href={item.githubPrUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-outline-variant px-2 py-1 text-xs text-accent-purple hover:bg-white/5"
          >
            <GitPullRequest className="size-3" />
            View PR #{item.githubPrNumber}
            {item.githubPrState === "draft" && (
              <StatusBadge tone="pending" className="ml-0.5">
                draft
              </StatusBadge>
            )}
            {item.githubPrState === "merged" && (
              <StatusBadge tone="synced" className="ml-0.5">
                merged
              </StatusBadge>
            )}
            {item.githubPrState === "closed" && (
              <StatusBadge tone="refactor" className="ml-0.5">
                closed
              </StatusBadge>
            )}
            <ExternalLink className="size-3" />
          </a>
        )}

        {onRemove &&
          (confirmingRemove ? (
            <div className="ml-auto inline-flex items-center gap-1.5">
              <span className="text-[11px] text-on-surface-variant">Remove permanently?</span>
              <button
                onClick={() => {
                  setConfirmingRemove(false);
                  onRemove();
                }}
                disabled={removing}
                title="Permanently remove this item — this can't be undone"
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border border-accent-orange/40 bg-accent-orange-bg px-2 py-1 text-xs font-medium text-accent-orange hover:bg-accent-orange/15",
                  removing && "cursor-not-allowed opacity-50",
                )}
              >
                <Trash2 className={cn("size-3", removing && "animate-pulse")} />
                {removing ? "Removing…" : "Confirm"}
              </button>
              <button
                onClick={() => setConfirmingRemove(false)}
                disabled={removing}
                className="inline-flex items-center rounded-md border border-outline-variant px-2 py-1 text-xs text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingRemove(true)}
              disabled={removing}
              title="Permanently remove this item"
              className={cn(
                "ml-auto inline-flex items-center gap-1 rounded-md border border-outline-variant px-2 py-1 text-xs text-on-surface-variant hover:border-accent-orange/40 hover:text-accent-orange",
                removing && "cursor-not-allowed opacity-50",
              )}
            >
              <Trash2 className={cn("size-3", removing && "animate-pulse")} />
              Remove
            </button>
          ))}
      </div>
    </div>
  );
}
