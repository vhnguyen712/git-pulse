/**
 * Small vertical bar chart, inline SVG, no charting library (see enhancement
 * roadmap D1 — avoids adding a dependency to a repo already flagged as a
 * modified Next.js build). Colors come from the app's CSS variables
 * (app/globals.css) so it matches the dark-only design system automatically.
 */
export interface BarDatum {
  label: string;
  value: number;
  /** CSS color value, e.g. "var(--accent-blue)". Defaults to --primary. */
  color?: string;
}

export function BarSeries({
  data,
  title,
  height = 100,
  emptyText = "No data yet.",
}: {
  data: BarDatum[];
  title: string;
  height?: number;
  emptyText?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const hasData = data.some((d) => d.value > 0);

  if (!hasData) {
    return <p className="text-xs text-on-surface-variant">{emptyText}</p>;
  }

  return (
    <div role="img" aria-label={title} className="flex flex-col gap-1">
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d, i) => {
          const barHeight = Math.max(2, (d.value / max) * height);
          return (
            <div
              key={i}
              className="group relative flex flex-1 flex-col items-center justify-end"
            >
              <span className="mb-0.5 text-[10px] text-on-surface-variant opacity-0 transition-opacity group-hover:opacity-100">
                {d.value}
              </span>
              <div
                className="w-full rounded-t-sm transition-opacity group-hover:opacity-80"
                style={{
                  height: barHeight,
                  backgroundColor: d.color ?? "var(--primary)",
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5">
        {data.map((d, i) => (
          <div
            key={i}
            className="flex-1 truncate text-center text-[10px] text-on-surface-variant"
            title={d.label}
          >
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
