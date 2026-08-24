/**
 * Minimal trend line — inline SVG polyline, no charting library (see
 * components/charts/bar-series.tsx for rationale).
 */
export function Sparkline({
  data,
  title,
  width = 200,
  height = 40,
  color = "var(--accent-blue)",
  emptyText = "No data yet.",
}: {
  data: number[];
  title: string;
  width?: number;
  height?: number;
  color?: string;
  emptyText?: string;
}) {
  if (data.length === 0) {
    return <p className="text-xs text-on-surface-variant">{emptyText}</p>;
  }
  if (data.length === 1) {
    return <p className="text-xs text-on-surface-variant">Not enough history yet.</p>;
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title}
      className="overflow-visible"
    >
      <title>{title}</title>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} />
      {data.map((v, i) => {
        const x = i * stepX;
        const y = height - ((v - min) / range) * height;
        return <circle key={i} cx={x} cy={y} r={2} fill={color} />;
      })}
    </svg>
  );
}
