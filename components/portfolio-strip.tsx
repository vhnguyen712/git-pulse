import { DonutChart } from "@/components/charts/donut-chart";
import type { PortfolioSummary } from "@/lib/portfolio";

/** Portfolio-level stat strip above the repo grid (roadmap #5). */
export function PortfolioStrip({ summary }: { summary: PortfolioSummary }) {
  if (summary.pinnedCount === 0) return null;

  const funnel = [
    { label: "Open", value: summary.openActionItems, color: "var(--accent-amber)" },
    { label: "Shipped", value: summary.shippedActionItems, color: "var(--accent-green)" },
  ];

  return (
    <div className="mb-6 grid grid-cols-1 gap-3 rounded-lg border border-outline-variant bg-surface p-4 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
      <Stat label="Pinned projects" value={summary.pinnedCount} />
      <Stat label="Need a sync" value={summary.staleCount} tone={summary.staleCount > 0 ? "amber" : undefined} />
      <Stat label="Open action items" value={summary.openActionItems} />
      <Stat
        label="Most active"
        value={summary.mostActiveRepo ? summary.mostActiveRepo.fullName : "—"}
        small
      />
      {(summary.openActionItems > 0 || summary.shippedActionItems > 0) && (
        <div className="flex items-center justify-center sm:justify-end">
          <DonutChart data={funnel} title="Action items: open vs shipped, across all projects" />
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  small,
}: {
  label: string;
  value: number | string;
  tone?: "amber";
  small?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-on-surface-variant">{label}</span>
      <span
        className={
          small
            ? "truncate font-heading text-sm font-semibold text-on-surface"
            : `font-heading text-xl font-semibold ${tone === "amber" ? "text-accent-amber" : "text-on-surface"}`
        }
      >
        {value}
      </span>
    </div>
  );
}
