import { History } from "lucide-react";
import type { SyncHistoryEntry } from "@/lib/history";
import { Sparkline } from "@/components/charts/sparkline";
import { MonoText, shortSha } from "@/components/mono-text";
import { timeAgo } from "@/lib/format";

/** Historical view over every past analysis for a project (roadmap #1) — the
 * main workspace only ever shows the latest `aiSummaries` row; this surfaces
 * everything else that's already persisted. */
export function HistoryTimeline({ history }: { history: SyncHistoryEntry[] }) {
  if (history.length === 0) {
    return null;
  }

  const shippedTrend = history.map((h) => h.itemStatusCounts.synced);
  const proposedTrend = history.map(
    (h) => h.itemStatusCounts.suggested + h.itemStatusCounts.approved,
  );
  const tokenTrend = history
    .filter((h) => h.totalTokens != null)
    .map((h) => h.totalTokens as number);

  const totalCost = history.reduce((sum, h) => sum + (h.estimatedCostUsd ?? 0), 0);
  const hasCost = history.some((h) => h.estimatedCostUsd != null);

  return (
    <section className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center gap-1.5 text-on-surface">
        <History className="size-4" />
        <h2 className="font-heading text-sm font-semibold">History</h2>
        <span className="text-xs text-on-surface-variant">
          {history.length} sync{history.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <TrendCard title="Shipped next-steps per sync" data={shippedTrend} color="var(--accent-green)" />
        <TrendCard title="Proposed (open) per sync" data={proposedTrend} color="var(--accent-amber)" />
        {tokenTrend.length > 0 && (
          <TrendCard title="Tokens spent per sync" data={tokenTrend} color="var(--accent-blue)" />
        )}
      </div>

      {hasCost && (
        <p className="text-xs text-on-surface-variant">
          Estimated total spend across all syncs:{" "}
          <span className="text-on-surface">${totalCost.toFixed(4)}</span>
        </p>
      )}

      <ol className="flex flex-col gap-2">
        {[...history].reverse().map((h) => (
          <li
            key={h.id}
            className="flex flex-col gap-1 rounded-md border border-outline-variant px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-on-surface-variant">{timeAgo(h.createdAt)}</span>
              <MonoText size="sm" muted>
                {h.baseSha ? `${shortSha(h.baseSha)}…${shortSha(h.headSha)}` : shortSha(h.headSha)}
              </MonoText>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-on-surface-variant">
              <span>{h.counts.achievements} achievements</span>
              <span>{h.counts.nextSteps} next-steps</span>
              <span>{h.counts.brainstormIdeas} ideas</span>
              <span className="text-accent-green">{h.itemStatusCounts.synced} shipped</span>
              {h.totalTokens != null && <span>{h.totalTokens.toLocaleString()} tok</span>}
              {h.estimatedCostUsd != null && <span>${h.estimatedCostUsd.toFixed(4)}</span>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TrendCard({ title, data, color }: { title: string; data: number[]; color: string }) {
  return (
    <div className="rounded-md border border-outline-variant p-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
        {title}
      </p>
      <Sparkline data={data} title={title} color={color} width={180} height={36} />
    </div>
  );
}
