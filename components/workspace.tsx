"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Boxes,
  Check,
  Component,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  Layers,
  Lightbulb,
  RefreshCw,
  ScrollText,
  Sparkles,
  Target,
  Zap,
} from "lucide-react";
import type { WorkspaceData } from "@/lib/workspace";
import type { PrCandidate, ConflictInfo } from "@/lib/pulls";
import type { ActionItem, Project } from "@/lib/db/schema";
import type { Analysis, ProjectOverview } from "@/lib/schema";
import { MonoText, shortSha } from "@/components/mono-text";
import { PulseIndicator } from "@/components/pulse-indicator";
import { BranchSelect } from "@/components/branch-select";
import { WorktreesPanel } from "@/components/worktrees-panel";
import { ActionItemCard } from "@/components/action-item-card";
import { StatusBadge } from "@/components/status-badge";
import { useTerminal } from "@/components/terminal-context";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import { BarSeries, type BarDatum } from "@/components/charts/bar-series";
import { DonutChart, type DonutDatum } from "@/components/charts/donut-chart";
import { HistoryTimeline } from "@/components/history-timeline";
import type { CompareCommit, PullRequestSummary } from "@/lib/github";

interface SyncErrorInfo {
  message: string;
  resetAt?: number;
}

type TabKey = "git" | "insights" | "summary" | "brainstorm" | "pulls" | "history";

const TABS: { key: TabKey; title: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "git", title: "Git Activity", icon: GitCommitHorizontal },
  { key: "insights", title: "AI Core Insights", icon: Sparkles },
  { key: "summary", title: "Project Summary", icon: ScrollText },
  { key: "brainstorm", title: "Idea & Brainstorm Lab", icon: Lightbulb },
  { key: "pulls", title: "Pull Requests", icon: GitPullRequest },
  { key: "history", title: "History", icon: History },
];

export function Workspace({
  owner,
  repoName,
  initial,
}: {
  owner: string;
  repoName: string;
  initial: WorkspaceData;
}) {
  const router = useRouter();
  const [, startRefresh] = useTransition();

  const [project, setProject] = useState<Project | null>(initial.project);
  const [commits, setCommits] = useState(initial.commits);
  const [analysis, setAnalysis] = useState<Analysis | null>(initial.latestSummary);
  const [items, setItems] = useState<ActionItem[]>(initial.actionItems);

  const [branch, setBranch] = useState(initial.syncBranch);
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<SyncErrorInfo | null>(null);

  const [pushingId, setPushingId] = useState<string | null>(null);
  const [pushErrors, setPushErrors] = useState<Record<string, string>>({});
  const [removingId, setRemovingId] = useState<string | null>(null);

  const [pulls, setPulls] = useState<PullRequestSummary[]>(initial.pulls);
  const [prCandidates, setPrCandidates] = useState<PrCandidate[]>(initial.prCandidates);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>(initial.conflicts);
  const [pullsRefreshing, setPullsRefreshing] = useState(false);
  const [pullsError, setPullsError] = useState<string | null>(null);
  const [openingPrId, setOpeningPrId] = useState<string | null>(null);

  const conflictsByItemId = new Map(conflicts.map((c) => [c.actionItemId, c]));

  const { openTerminal } = useTerminal();
  function handleOpenTerminal(prompt: string, title: string, agentId?: string, startRef?: string) {
    if (project) openTerminal(project, prompt, title, agentId, startRef);
  }

  const [activeTab, setActiveTab] = useState<TabKey>("git");

  async function handleSync() {
    setSyncing(true);
    setSyncNotice(null);
    setSyncError(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo: repoName, branch }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 429) {
          setSyncError({ message: "GitHub rate limit reached.", resetAt: body.resetAt });
        } else if (res.status === 502) {
          setSyncError({ message: body.message ?? "The AI returned an invalid response." });
        } else if (res.status === 503) {
          setSyncError({
            message: body.message ?? "The AI service is currently unavailable. Please try again shortly.",
          });
        } else {
          setSyncError({
            message: body.detail ? `${body.error ?? "Sync failed."} ${body.detail}` : body.error ?? "Sync failed.",
          });
        }
        return;
      }

      if (body.upToDate) {
        setSyncNotice("Nothing new since last sync.");
        setProject(body.project);
        return;
      }

      if (body.analysisUnavailable) {
        setProject(body.project);
        setCommits(body.commits);
        setSyncError({
          message:
            "New commits were synced, but AI analysis is temporarily unavailable. It will be retried on the next sync.",
        });
        return;
      }

      setProject(body.project);
      setCommits(body.commits);
      setAnalysis(body.analysis);
      setItems(body.actionItems);
      setSyncNotice(body.cached ? "Loaded cached analysis for this range." : null);
      // Picks up the new ai_summaries row for the History section below
      // (not part of the sync response) and refreshed unread/rollup counts.
      if (!body.cached) startRefresh(() => router.refresh());
    } catch {
      setSyncError({ message: "Network error while syncing." });
    } finally {
      setSyncing(false);
    }
  }

  async function handlePush(item: ActionItem) {
    setPushingId(item.id);
    setPushErrors((e) => ({ ...e, [item.id]: "" }));
    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionItemId: item.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPushErrors((e) => ({ ...e, [item.id]: body.error ?? "Failed to create issue." }));
        return;
      }
      setItems((prev) => prev.map((i) => (i.id === item.id ? body.actionItem : i)));
    } catch {
      setPushErrors((e) => ({ ...e, [item.id]: "Network error." }));
    } finally {
      setPushingId(null);
    }
  }

  async function handleRemove(item: ActionItem) {
    setRemovingId(item.id);
    try {
      const res = await fetch("/api/action-items", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionItemId: item.id }),
      });
      if (!res.ok) return;
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      startRefresh(() => router.refresh());
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRefreshPulls() {
    setPullsRefreshing(true);
    setPullsError(null);
    try {
      const res = await fetch(`/api/pulls?owner=${owner}&repo=${repoName}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPullsError(body.error ?? "Failed to load pull requests.");
        return;
      }
      setPulls(body.pulls);
      setPrCandidates(body.candidates);
      setConflicts(body.conflicts ?? []);
      // Merge the reconciled rows back in so card "View PR" links refresh too.
      const byId = new Map<string, ActionItem>(
        (body.actionItems ?? []).map((i: ActionItem) => [i.id, i]),
      );
      setItems((prev) => prev.map((i) => byId.get(i.id) ?? i));
    } catch {
      setPullsError("Network error while loading pull requests.");
    } finally {
      setPullsRefreshing(false);
    }
  }

  async function handleOpenPr(candidate: PrCandidate) {
    setOpeningPrId(candidate.actionItemId);
    setPullsError(null);
    try {
      const res = await fetch("/api/pulls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionItemId: candidate.actionItemId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPullsError(body.error ?? "Failed to open pull request.");
        return;
      }
      setItems((prev) => prev.map((i) => (i.id === candidate.actionItemId ? body.actionItem : i)));
      setPrCandidates((prev) => prev.filter((c) => c.actionItemId !== candidate.actionItemId));
    } catch {
      setPullsError("Network error while opening the pull request.");
    } finally {
      setOpeningPrId(null);
    }
  }

  const nextSteps = items.filter((i) => i.source === "next_step");
  const brainstorm = items.filter((i) => i.source === "brainstorm");
  const hasAnalysis = analysis !== null;

  const commitActivity = commitsByDay(commits);
  const statusFunnel: DonutDatum[] = [
    {
      label: "Suggested",
      value: items.filter((i) => i.status === "suggested").length,
      color: "var(--accent-amber)",
      description: "AI-surfaced idea, not yet reviewed.",
    },
    {
      label: "Approved",
      value: items.filter((i) => i.status === "approved").length,
      color: "var(--accent-blue)",
      description: "Reviewed and greenlit, not yet pushed to GitHub.",
    },
    {
      label: "Synced",
      value: items.filter((i) => i.status === "synced").length,
      color: "var(--accent-green)",
      description: "Filed as a GitHub issue.",
    },
    {
      label: "Shipped",
      value: items.filter((i) => i.status === "shipped").length,
      color: "var(--accent-green)",
      description: "Its pull request was merged.",
    },
    {
      label: "Dismissed",
      value: items.filter((i) => i.status === "dismissed").length,
      color: "var(--accent-purple)",
      description: "Rejected — won't be pushed or synced.",
    },
  ];
  const priorityBreakdown: BarDatum[] = (["high", "medium", "low"] as const).map((p) => ({
    label: p,
    value: nextSteps.filter((i) => i.priority === p).length,
    color:
      p === "high" ? "var(--accent-orange)" : p === "medium" ? "var(--accent-amber)" : "var(--accent-purple)",
  }));

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex flex-col gap-3 border-b border-outline-variant bg-surface-container-low px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate font-heading text-base font-semibold text-on-surface">
              {owner}/{repoName}
            </h1>
            <p className="text-xs text-on-surface-variant">
              {syncing ? (
                <PulseIndicator state="processing" label="Analyzing…" />
              ) : project?.lastSyncedAt ? (
                `synced ${timeAgo(project.lastSyncedAt)}`
              ) : (
                "not yet analyzed"
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`https://github.com/${owner}/${repoName}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-md border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface-variant hover:bg-white/5"
          >
            GitHub
            <ExternalLink className="size-3" />
          </a>
          {project?.localPath && <WorktreesPanel projectId={project.id} />}
          <BranchSelect
            owner={owner}
            repo={repoName}
            value={branch}
            onChange={setBranch}
            disabled={syncing}
            align="right"
          />
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={syncing ? "size-3.5 animate-spin" : "size-3.5"} />
            Sync now
          </button>
        </div>
      </div>

      {(syncNotice || syncError) && (
        <div
          className={
            syncError
              ? "border-b border-accent-orange/30 bg-accent-orange-bg px-4 py-2 text-xs text-accent-orange sm:px-6"
              : "border-b border-outline-variant bg-surface-container-low px-4 py-2 text-xs text-on-surface-variant sm:px-6"
          }
        >
          {syncError
            ? `${syncError.message}${
                syncError.resetAt
                  ? ` Resets at ${new Date(syncError.resetAt * 1000).toLocaleTimeString()}.`
                  : ""
              }`
            : syncNotice}
        </div>
      )}

      {/* Tabbed workspace */}
      <div className="scroll-fade flex items-center gap-1 overflow-x-auto border-b border-outline-variant bg-surface-container-low px-4 sm:px-6">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={
                isActive
                  ? "flex shrink-0 items-center gap-1.5 border-b-2 border-primary px-3 py-2.5 text-sm font-medium text-on-surface"
                  : "flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-sm text-on-surface-variant hover:text-on-surface"
              }
            >
              <Icon className="size-4" />
              {tab.title}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Git Activity */}
        <section className={activeTab === "git" ? "flex flex-col gap-3 p-4 sm:p-6" : "hidden"}>
          {commits.length > 0 && (
            <BarSeries data={commitActivity} title="Commits per day (last 14 days)" height={64} />
          )}
          {commits.length === 0 ? (
            <EmptyNote text="No commits found." />
          ) : (
            <ul className="flex flex-col gap-3">
              {groupCommitsByDay(commits).map((group) => (
                <li key={group.key}>
                  <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
                    {group.label}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {group.commits.map((c) => (
                      <li key={c.sha}>
                        <a
                          href={`https://github.com/${owner}/${repoName}/commit/${c.sha}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded-md px-2 py-1.5 text-xs hover:bg-white/[0.03]"
                        >
                          <div className="flex items-baseline gap-2">
                            <MonoText size="sm" muted>
                              {shortSha(c.sha)}
                            </MonoText>
                            <span className="truncate text-on-surface">
                              {c.message.split("\n")[0]}
                            </span>
                          </div>
                          <div className="pl-0 text-[11px] text-on-surface-variant">
                            {c.authorName ?? "unknown"} · {timeAgo(c.authorDate)}
                          </div>
                        </a>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* AI Core Insights */}
        <section className={activeTab === "insights" ? "flex flex-col gap-4 p-4 sm:p-6" : "hidden"}>
          {syncing ? (
            <InsightsSkeleton />
          ) : !hasAnalysis ? (
            <EmptyNote text="Nothing analyzed yet. Click Sync now to generate a summary." />
          ) : (
            <>
              {items.length > 0 && (
                <div className="flex flex-col gap-3 rounded-lg border border-outline-variant p-3">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">
                    Action-item funnel
                  </p>
                  <DonutChart data={statusFunnel} title="Action items by status" />
                  {nextSteps.length > 0 && (
                    <BarSeries data={priorityBreakdown} title="Next steps by priority" height={48} />
                  )}
                </div>
              )}
              <SummaryBlock title="Key achievements" lines={analysis!.summary.key_achievements} />
              <SummaryBlock
                title="Fixes & refactoring"
                lines={analysis!.summary.fixes_and_refactoring}
              />
              <SummaryBlock
                title="Architectural changes"
                lines={analysis!.summary.architectural_changes}
              />

              <div>
                <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-on-surface-variant">
                  Next Sprint Plan
                </h3>
                {nextSteps.length === 0 ? (
                  <EmptyNote text="No next steps suggested." />
                ) : (
                  <div className="flex flex-col gap-2">
                    {nextSteps.map((item) => (
                      <ActionItemCard
                        key={item.id}
                        item={item}
                        pushing={pushingId === item.id}
                        error={pushErrors[item.id]}
                        baseBranch={project?.defaultBranch ?? branch}
                        conflict={conflictsByItemId.get(item.id)}
                        onPush={() => handlePush(item)}
                        onOpenTerminal={handleOpenTerminal}
                        onRemove={() => handleRemove(item)}
                        removing={removingId === item.id}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        {/* Project Summary — README-style living overview, LLM-synthesized fresh on each sync */}
        <section className={activeTab === "summary" ? "flex flex-col" : "hidden"}>
          {syncing ? (
            <div className="p-4 sm:p-6">
              <InsightsSkeleton />
            </div>
          ) : !initial.projectOverview ? (
            <div className="p-4 sm:p-6">
              <EmptyNote text="Sync now to generate a project overview." />
            </div>
          ) : (
            <ProjectOverviewView
              overview={initial.projectOverview}
              projectName={`${owner}/${repoName}`}
            />
          )}
        </section>

        {/* Idea & Brainstorm Lab */}
        <section className={activeTab === "brainstorm" ? "flex flex-col gap-3 p-4 sm:p-6" : "hidden"}>
          {syncing ? (
            <InsightsSkeleton compact />
          ) : !hasAnalysis ? (
            <EmptyNote text="Nothing analyzed yet. Click Sync now to generate ideas." />
          ) : brainstorm.length === 0 ? (
            <EmptyNote text="No ideas suggested this round." />
          ) : (
            <div className="flex flex-col gap-2">
              {brainstorm.map((item) => (
                <ActionItemCard
                  key={item.id}
                  item={item}
                  pushing={pushingId === item.id}
                  error={pushErrors[item.id]}
                  baseBranch={project?.defaultBranch ?? branch}
                  conflict={conflictsByItemId.get(item.id)}
                  onPush={() => handlePush(item)}
                  onOpenTerminal={handleOpenTerminal}
                  onRemove={() => handleRemove(item)}
                  removing={removingId === item.id}
                />
              ))}
            </div>
          )}
        </section>

        {/* Pull Requests */}
        <section className={activeTab === "pulls" ? "flex flex-col gap-4 p-4 sm:p-6" : "hidden"}>
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">
              Open pull requests
            </p>
            <button
              onClick={handleRefreshPulls}
              disabled={pullsRefreshing}
              className="flex items-center gap-1.5 rounded-md border border-outline-variant px-2 py-1 text-xs text-on-surface-variant hover:bg-white/5 hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={pullsRefreshing ? "size-3 animate-spin" : "size-3"} />
              Refresh
            </button>
          </div>

          {pullsError && <p className="text-xs text-accent-orange">{pullsError}</p>}

          {pulls.length === 0 ? (
            <EmptyNote text="No open pull requests." />
          ) : (
            <ul className="flex flex-col gap-2">
              {pulls.map((pr) => (
                <li
                  key={pr.number}
                  className="flex flex-col gap-1 rounded-lg border border-outline-variant bg-surface p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <a
                      href={pr.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-medium text-on-surface hover:text-accent-purple"
                    >
                      {pr.title}
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                    <StatusBadge tone={pr.isDraft ? "pending" : "feature"}>
                      {pr.isDraft ? "draft" : "open"}
                    </StatusBadge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
                    <span>#{pr.number}</span>
                    <span>{pr.author ?? "unknown"}</span>
                    <MonoText size="sm" muted>
                      {pr.headRef} → {pr.baseRef}
                    </MonoText>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {prCandidates.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">
                Ready to open
              </p>
              <ul className="flex flex-col gap-2">
                {prCandidates.map((candidate) => (
                  <li
                    key={candidate.actionItemId}
                    className="flex items-center justify-between gap-2 rounded-lg border border-outline-variant bg-surface p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-on-surface">{candidate.title}</p>
                      <MonoText size="sm" muted>
                        {candidate.branch}
                      </MonoText>
                    </div>
                    <button
                      onClick={() => handleOpenPr(candidate)}
                      disabled={openingPrId === candidate.actionItemId}
                      className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-xs font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <GitPullRequest
                        className={
                          openingPrId === candidate.actionItemId ? "size-3 animate-pulse" : "size-3"
                        }
                      />
                      {openingPrId === candidate.actionItemId ? "Opening…" : "Open draft PR"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* History */}
        <div className={activeTab === "history" ? "block" : "hidden"}>
          {initial.history.length === 0 ? (
            <div className="p-4 sm:p-6">
              <EmptyNote text="No sync history yet." />
            </div>
          ) : (
            <HistoryTimeline history={initial.history} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Buckets commits (assumed already ordered) into consecutive same-day runs, for the Git Activity list's date headers. */
function groupCommitsByDay(
  commits: CompareCommit[],
): { key: string; label: string; commits: CompareCommit[] }[] {
  const groups: { key: string; label: string; commits: CompareCommit[] }[] = [];
  for (const c of commits) {
    const key = c.authorDate ? c.authorDate.slice(0, 10) : "unknown";
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.commits.push(c);
    } else {
      groups.push({
        key,
        label: c.authorDate
          ? new Date(c.authorDate).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          : "Unknown date",
        commits: [c],
      });
    }
  }
  return groups;
}

const ACTIVITY_DAYS = 14;

/** Bucket commits into the last N calendar days for the Git Activity bar chart. */
function commitsByDay(commits: CompareCommit[]): BarDatum[] {
  const days: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push({
      key: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString(undefined, { day: "numeric" }),
    });
  }

  const counts = new Map<string, number>();
  for (const c of commits) {
    if (!c.authorDate) continue;
    const key = c.authorDate.slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return days.map((d) => ({
    label: d.label,
    value: counts.get(d.key) ?? 0,
  }));
}

function SummaryBlock({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="border-l-2 border-outline-variant pl-3">
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-on-surface-variant">
        {title}
      </h3>
      <ul className="flex flex-col gap-1">
        {lines.map((line, i) => (
          <li key={i} className="text-xs leading-relaxed text-on-surface">
            • {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-on-surface-variant">{text}</p>;
}

type OverviewSectionId = "context" | "objective" | "features" | "architecture" | "stack";
type OverviewIcon = React.ComponentType<{ className?: string }>;

/** Cycling accent tiles for numbered feature cards — accent-as-badge, used sparingly per the design system. */
const OVERVIEW_ACCENTS = [
  "text-accent-blue bg-accent-blue-bg",
  "text-accent-purple bg-accent-purple-bg",
  "text-accent-green bg-accent-green-bg",
  "text-accent-amber bg-accent-amber-bg",
  "text-accent-orange bg-accent-orange-bg",
] as const;

/** Serializes the overview to Markdown for the "Copy as Markdown" action — the readme it reads like. */
function overviewToMarkdown(overview: ProjectOverview, projectName: string): string {
  const lines: string[] = [`# ${projectName}`];
  if (overview.tagline) lines.push("", `> ${overview.tagline}`);
  if (overview.context) lines.push("", "## Context", "", overview.context);
  if (overview.objective) lines.push("", "## Objective", "", overview.objective);
  if (overview.highlighted_features.length) {
    lines.push("", "## Highlighted features", "");
    for (const f of overview.highlighted_features) lines.push(`- **${f.name}** — ${f.description}`);
  }
  if (overview.architecture.overview || overview.architecture.components.length) {
    lines.push("", "## Architecture");
    if (overview.architecture.overview) lines.push("", overview.architecture.overview);
    if (overview.architecture.components.length) {
      lines.push("");
      for (const c of overview.architecture.components) lines.push(`- **${c.name}** — ${c.description}`);
    }
  }
  if (overview.tech_stack.length) {
    lines.push("", "## Tech stack", "", overview.tech_stack.map((t) => `\`${t}\``).join(" · "));
  }
  return lines.join("\n") + "\n";
}

/** README-style rendering of the LLM-synthesized project overview (Project Summary tab). */
function ProjectOverviewView({
  overview,
  projectName,
}: {
  overview: ProjectOverview;
  projectName: string;
}) {
  const hasFeatures = overview.highlighted_features.length > 0;
  const hasComponents = overview.architecture.components.length > 0;
  const hasArchitecture = overview.architecture.overview.length > 0 || hasComponents;

  // The sections that actually have content — drives both the sticky in-page
  // nav and the scroll-spy below.
  const sections = useMemo(() => {
    const s: { id: OverviewSectionId; label: string; icon: OverviewIcon }[] = [];
    if (overview.context) s.push({ id: "context", label: "Context", icon: BookOpen });
    if (overview.objective) s.push({ id: "objective", label: "Objective", icon: Target });
    if (hasFeatures) s.push({ id: "features", label: "Features", icon: Zap });
    if (hasArchitecture) s.push({ id: "architecture", label: "Architecture", icon: Boxes });
    if (overview.tech_stack.length) s.push({ id: "stack", label: "Tech stack", icon: Layers });
    return s;
  }, [overview, hasFeatures, hasArchitecture]);

  const [activeId, setActiveId] = useState<OverviewSectionId | null>(sections[0]?.id ?? null);
  // Trailing spacer so the last sections can scroll their top up to the nav
  // line — without it there's no room below them and their nav links can't
  // become active (see scroll-spy below).
  const [spacerHeight, setSpacerHeight] = useState(0);
  const refs = useRef<Partial<Record<OverviewSectionId, HTMLElement | null>>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  // The sticky nav's height — offset so a section counts as "active" (and is
  // scrolled to) just below the nav rather than under it.
  const NAV_OFFSET = 88;

  // Position-based scroll-spy: the active section is the last one whose top has
  // crossed the nav line. The spacer above guarantees every section — including
  // the final ones — can reach that line, so clicking any nav link works in
  // both directions.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Nearest scrollable ancestor (the workspace's overflow-y-auto pane).
    let sc: HTMLElement | null = root.parentElement;
    while (sc) {
      const oy = getComputedStyle(sc).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      sc = sc.parentElement;
    }
    scrollerRef.current = sc;
    if (!sc) return;

    // Enough trailing space for the last section's top to reach the nav line.
    const recomputeSpacer = () => {
      if (sections.length <= 1) {
        setSpacerHeight(0);
        return;
      }
      const lastEl = refs.current[sections[sections.length - 1].id];
      if (!lastEl) return;
      setSpacerHeight(Math.max(0, sc!.clientHeight - NAV_OFFSET - lastEl.offsetHeight));
    };

    const onScroll = () => {
      const scRect = sc!.getBoundingClientRect();
      let current = sections[0]?.id ?? null;
      for (const s of sections) {
        const el = refs.current[s.id];
        if (!el) continue;
        const top = el.getBoundingClientRect().top - scRect.top;
        if (top <= NAV_OFFSET + 4) current = s.id;
      }
      if (current) setActiveId(current);
    };

    recomputeSpacer();
    onScroll();
    sc.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", recomputeSpacer);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", recomputeSpacer);
    };
  }, [sections]);

  const scrollToSection = (id: OverviewSectionId) => {
    const el = refs.current[id];
    const sc = scrollerRef.current;
    if (!el) return;
    if (sc) {
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      sc.scrollTo({ top: Math.max(0, top - NAV_OFFSET), behavior: "smooth" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const markdown = overviewToMarkdown(overview, projectName);

  return (
    <div ref={rootRef}>
      {/* Sticky in-page nav — jump between sections, current one highlighted */}
      {sections.length > 1 && (
        <div className="scroll-fade sticky top-0 z-10 flex items-center gap-1 overflow-x-auto border-b border-outline-variant bg-surface-container-low px-4 py-2 sm:px-6">
          {sections.map((s) => {
            const Icon = s.icon;
            const active = activeId === s.id;
            return (
              <button
                key={s.id}
                onClick={() => scrollToSection(s.id)}
                className={
                  active
                    ? "flex shrink-0 items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-on-surface"
                    : "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-on-surface-variant transition-colors hover:bg-white/[0.03] hover:text-on-surface"
                }
              >
                <Icon className="size-3.5" />
                {s.label}
              </button>
            );
          })}
          <div className="ml-auto shrink-0 pl-2">
            <CopyMarkdownButton markdown={markdown} />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-8 p-4 sm:p-6">
        {/* Hero */}
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-purple-bg text-accent-purple">
                <ScrollText className="size-4" />
              </span>
              <h2 className="text-lg font-semibold text-on-surface">{projectName}</h2>
            </div>
            {sections.length <= 1 && <CopyMarkdownButton markdown={markdown} />}
          </div>
          {overview.tagline && (
            <p className="max-w-2xl text-sm leading-relaxed text-on-surface-variant">
              {overview.tagline}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {hasFeatures && (
              <OverviewStat value={overview.highlighted_features.length} label="features" />
            )}
            {hasComponents && (
              <OverviewStat value={overview.architecture.components.length} label="components" />
            )}
            {overview.tech_stack.length > 0 && (
              <OverviewStat value={overview.tech_stack.length} label="technologies" />
            )}
          </div>
        </div>

        {overview.context && (
          <OverviewSection
            id="context"
            title="Context"
            icon={BookOpen}
            setRef={(el) => {
              refs.current.context = el;
            }}
          >
            <ProseText text={overview.context} />
          </OverviewSection>
        )}

        {overview.objective && (
          <OverviewSection
            id="objective"
            title="Objective"
            icon={Target}
            setRef={(el) => {
              refs.current.objective = el;
            }}
          >
            <ProseText text={overview.objective} />
          </OverviewSection>
        )}

        {hasFeatures && (
          <OverviewSection
            id="features"
            title="Highlighted features"
            icon={Zap}
            setRef={(el) => {
              refs.current.features = el;
            }}
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {overview.highlighted_features.map((f, i) => (
                <div
                  key={i}
                  className="flex gap-3 rounded-lg border border-outline-variant p-3 transition-colors hover:border-outline hover:bg-white/[0.03]"
                >
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-bold tabular-nums ${OVERVIEW_ACCENTS[i % OVERVIEW_ACCENTS.length]}`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-on-surface">{f.name}</p>
                    <p className="mt-1 text-xs leading-relaxed text-on-surface-variant">
                      {f.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </OverviewSection>
        )}

        {hasArchitecture && (
          <OverviewSection
            id="architecture"
            title="Architecture"
            icon={Boxes}
            setRef={(el) => {
              refs.current.architecture = el;
            }}
          >
            {overview.architecture.overview && <ProseText text={overview.architecture.overview} />}
            {hasComponents && (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {overview.architecture.components.map((c, i) => (
                  <div
                    key={i}
                    className="flex gap-3 rounded-lg border border-outline-variant p-3 transition-colors hover:border-outline hover:bg-white/[0.03]"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-purple-bg text-accent-purple">
                      <Component className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-on-surface">{c.name}</p>
                      <p className="mt-1 text-xs leading-relaxed text-on-surface-variant">
                        {c.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </OverviewSection>
        )}

        {overview.tech_stack.length > 0 && (
          <OverviewSection
            id="stack"
            title="Tech stack"
            icon={Layers}
            setRef={(el) => {
              refs.current.stack = el;
            }}
          >
            <div className="flex flex-wrap gap-1.5">
              {overview.tech_stack.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1.5 rounded-md border border-outline-variant px-2 py-1 text-xs text-on-surface-variant transition-colors hover:border-outline hover:text-on-surface"
                >
                  <span className="size-1.5 rounded-full bg-accent-green" />
                  {t}
                </span>
              ))}
            </div>
          </OverviewSection>
        )}
      </div>
      {spacerHeight > 0 && <div aria-hidden style={{ height: spacerHeight }} />}
    </div>
  );
}

function OverviewStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-md border border-outline-variant px-2.5 py-1">
      <span className="text-sm font-semibold tabular-nums text-on-surface">{value}</span>
      <span className="text-xs text-on-surface-variant">{label}</span>
    </div>
  );
}

function OverviewSection({
  id,
  title,
  icon: Icon,
  setRef,
  children,
}: {
  id: string;
  title: string;
  icon: OverviewIcon;
  setRef: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  return (
    <section id={id} ref={setRef} className="scroll-mt-16">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-on-surface-variant" />
        <h3 className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

/** Copies the overview as Markdown, swapping the icon/label to a check for feedback. */
function CopyMarkdownButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(markdown);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard unavailable (e.g. insecure context) — silently ignore
        }
      }}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-outline-variant px-2 py-1 text-xs text-on-surface-variant transition-colors hover:bg-white/5 hover:text-on-surface"
    >
      {copied ? <Check className="size-3 text-accent-green" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy as Markdown"}
    </button>
  );
}

/** Renders prose as paragraphs split on blank lines — the LLM may return multi-paragraph text. */
function ProseText({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/).filter(Boolean);
  return (
    <div className="flex flex-col gap-2">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-sm leading-relaxed text-on-surface">
          {p}
        </p>
      ))}
    </div>
  );
}

function InsightsSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-3 w-24 bg-surface-container" />
      <Skeleton className="h-3 w-full bg-surface-container" />
      <Skeleton className="h-3 w-5/6 bg-surface-container" />
      {!compact && (
        <>
          <Skeleton className="mt-3 h-3 w-32 bg-surface-container" />
          <Skeleton className="h-16 w-full bg-surface-container" />
        </>
      )}
    </div>
  );
}
