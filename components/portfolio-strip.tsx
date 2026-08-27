import Link from "next/link";
import { DonutChart } from "@/components/charts/donut-chart";
import { HealthBadge } from "@/components/health-badge";
import type { PortfolioSummary } from "@/lib/portfolio";

/** Portfolio-level stat strip above the repo grid (roadmap #5). */
export function PortfolioStrip({ summary }: { summary: PortfolioSummary }) {
  if (summary.pinnedCount === 0) return null;

  const funnel = [
    { label: "Open", value: summary.openActionItems, color: "var(--accent-amber)" },
    { label: "Shipped", value: summary.shippedActionItems, color: "var(--accent-green)" },
  ];

  return (
    <div className="mb-6 flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 rounded-lg border border-outline-variant bg-surface p-4 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
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

      {summary.coldProjects.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-wide text-on-surface-variant">
              Going cold
            </span>
            <span className="text-[11px] text-on-surface-variant">
              projects losing momentum — coldest first
            </span>
          </div>
          <ul className="flex flex-col divide-y divide-outline-variant">
            {summary.coldProjects.map((p) => {
              const [owner, name] = p.fullName.split("/");
              return (
                <li key={p.fullName} className="flex items-center justify-between gap-2 py-1.5">
                  <Link
                    href={`/project/${owner}/${name}`}
                    className="truncate font-heading text-sm text-on-surface hover:underline"
                  >
                    {p.fullName}
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] text-on-surface-variant">{p.health.reason}</span>
                    <HealthBadge health={p.health} />
                  </div>
                </li>
              );
            })}
          </ul>
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
