const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 days ago" / "just now" style relative time. */
export function timeAgo(input: string | number | null | undefined): string {
  if (!input) return "never";
  const date = typeof input === "number" ? input : new Date(input).getTime();
  const diff = date - Date.now();

  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) {
      return rtf.format(Math.round(diff / ms), unit);
    }
  }
  return "just now";
}

/** "12,345 tok" — token counts, grouped. Null/undefined → "—". */
export function formatTokens(tokens: number | null | undefined): string {
  if (tokens == null) return "—";
  return `${tokens.toLocaleString()} tok`;
}

/**
 * Estimated cost from integer micro-USD (as stored on runs/run_steps) → "$0.0123".
 * Null/undefined → "—". Matches the history timeline's `$` + 4-decimal convention.
 */
export function formatUsd(microUsd: number | null | undefined): string {
  if (microUsd == null) return "—";
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

/** "1.4s" / "2m 3s" / "450ms" — human duration from milliseconds. Null → "—". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
