"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ExternalLink,
  GitCommitHorizontal,
  Lightbulb,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { WorkspaceData } from "@/lib/workspace";
import type { ActionItem, Project } from "@/lib/db/schema";
import type { Analysis } from "@/lib/schema";
import { MonoText, shortSha } from "@/components/mono-text";
import { PulseIndicator } from "@/components/pulse-indicator";
import { ActionItemCard } from "@/components/action-item-card";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import { BarSeries, type BarDatum } from "@/components/charts/bar-series";
import { DonutChart, type DonutDatum } from "@/components/charts/donut-chart";
import { HistoryTimeline } from "@/components/history-timeline";
import type { CompareCommit } from "@/lib/github";

interface SyncErrorInfo {
  message: string;
  resetAt?: number;
}

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

  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<SyncErrorInfo | null>(null);

  const [pushingId, setPushingId] = useState<string | null>(null);
  const [pushErrors, setPushErrors] = useState<Record<string, string>>({});

  async function handleSync() {
    setSyncing(true);
    setSyncNotice(null);
    setSyncError(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo: repoName }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 429) {
          setSyncError({ message: "GitHub rate limit reached.", resetAt: body.resetAt });
        } else if (res.status === 502) {
          setSyncError({ message: body.message ?? "The AI returned an invalid response." });
        } else {
          setSyncError({ message: body.error ?? "Sync failed." });
        }
        return;
      }

      if (body.upToDate) {
        setSyncNotice("Nothing new since last sync.");
        setProject(body.project);
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

  const nextSteps = items.filter((i) => i.source === "next_step");
  const brainstorm = items.filter((i) => i.source === "brainstorm");
  const hasAnalysis = analysis !== null;

  const commitActivity = commitsByDay(commits);
  const statusFunnel: DonutDatum[] = [
    { label: "Suggested", value: items.filter((i) => i.status === "suggested").length, color: "var(--accent-amber)" },
    { label: "Approved", value: items.filter((i) => i.status === "approved").length, color: "var(--accent-blue)" },
    { label: "Synced", value: items.filter((i) => i.status === "synced").length, color: "var(--accent-green)" },
    { label: "Dismissed", value: items.filter((i) => i.status === "dismissed").length, color: "var(--accent-purple)" },
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

      {/* 3-panel workspace */}
      <div className="grid flex-1 grid-cols-1 divide-y divide-outline-variant lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        {/* Column 1 — Git Activity */}
        <section className="flex flex-col gap-3 p-4 sm:p-6">
          <ColumnHeader icon={GitCommitHorizontal} title="Git Activity" />
          {commits.length > 0 && (
            <BarSeries data={commitActivity} title="Commits per day (last 14 days)" height={64} />
          )}
          {commits.length === 0 ? (
            <EmptyNote text="No commits found." />
          ) : (
            <ul className="flex flex-col gap-1">
              {commits.map((c) => (
                <li
                  key={c.sha}
                  className="rounded-md px-2 py-1.5 text-xs hover:bg-white/[0.03]"
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
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Column 2 — AI Core Insights */}
        <section className="flex flex-col gap-4 p-4 sm:p-6">
          <ColumnHeader icon={Sparkles} title="AI Core Insights" />
          {syncing ? (
            <InsightsSkeleton />
          ) : !hasAnalysis ? (
            <EmptyNote text="Nothing analyzed yet. Click Sync now to generate a summary." />
          ) : (
            <>
              {items.length > 0 && (
                <div className="flex flex-col gap-3 rounded-md border border-outline-variant p-3">
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
                        onPush={() => handlePush(item)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        {/* Column 3 — Idea & Brainstorm Lab */}
        <section className="flex flex-col gap-3 p-4 sm:p-6">
          <ColumnHeader icon={Lightbulb} title="Idea & Brainstorm Lab" />
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
                  onPush={() => handlePush(item)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <HistoryTimeline history={initial.history} />
    </div>
  );
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

function ColumnHeader({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-on-surface">
      <Icon className="size-4" />
      <h2 className="font-heading text-sm font-semibold">{title}</h2>
    </div>
  );
}

function SummaryBlock({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div>
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
