/**
 * Donut chart for status/category breakdowns (e.g. action-item funnel).
 * Inline SVG built from stroke-dasharray arcs — see components/charts/bar-series.tsx
 * for why no charting library is used.
 */
export interface DonutDatum {
  label: string;
  value: number;
  /** CSS color value, e.g. "var(--accent-green)". */
  color: string;
}

const SIZE = 96;
const STROKE = 14;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function DonutChart({
  data,
  title,
  emptyText = "No data yet.",
}: {
  data: DonutDatum[];
  title: string;
  emptyText?: string;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (total === 0) {
    return <p className="text-xs text-on-surface-variant">{emptyText}</p>;
  }

  const arcs = data
    .filter((d) => d.value > 0)
    .reduce<{ items: (DonutDatum & { dasharray: string; dashoffset: number })[]; offset: number }>(
      (acc, d) => {
        const dash = (d.value / total) * CIRCUMFERENCE;
        acc.items.push({
          ...d,
          dasharray: `${dash} ${CIRCUMFERENCE - dash}`,
          dashoffset: -acc.offset,
        });
        return { items: acc.items, offset: acc.offset + dash };
      },
      { items: [], offset: 0 },
    ).items;

  return (
    <div className="flex items-center gap-4">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={title}
        className="shrink-0 -rotate-90"
      >
        <title>{title}</title>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="var(--surface-container)"
          strokeWidth={STROKE}
        />
        {arcs.map((a, i) => (
          <circle
            key={i}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={a.color}
            strokeWidth={STROKE}
            strokeDasharray={a.dasharray}
            strokeDashoffset={a.dashoffset}
          />
        ))}
      </svg>
      <ul className="flex flex-col gap-1 text-xs">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-1.5 text-on-surface-variant">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: d.color }}
            />
            <span className="text-on-surface">{d.label}</span>
            <span>{d.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
