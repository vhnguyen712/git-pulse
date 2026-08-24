import { cn } from "@/lib/utils";

/**
 * "The Pulse" — reserved exclusively for active system processes / live data,
 * per the design spec. Do not use for decoration.
 *
 * - "processing": amber, animated — an AI analysis or sync is in flight.
 * - "live": green, animated — a connection/state is actively current.
 * - "idle": static outline dot — nothing is happening (rendered for layout
 *   stability, not to imply activity).
 */
export type PulseState = "processing" | "live" | "idle";

const STATE_CLASSES: Record<PulseState, string> = {
  processing: "bg-accent-amber pulse-dot",
  live: "bg-accent-green pulse-dot",
  idle: "bg-outline-variant",
};

export function PulseIndicator({
  state,
  label,
  className,
}: {
  state: PulseState;
  /** Accessible label; also shown as adjacent text when provided. */
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        role="status"
        aria-label={label ?? state}
        className={cn("size-2 shrink-0 rounded-full", STATE_CLASSES[state])}
      />
      {label ? (
        <span className="text-xs text-muted-foreground">{label}</span>
      ) : null}
    </span>
  );
}
