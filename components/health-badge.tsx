import type { RepoHealth, HealthBand } from "@/lib/portfolio";
import { StatusBadge, type BadgeTone } from "@/components/status-badge";

const BAND_TONE: Record<HealthBand, BadgeTone> = {
  active: "synced", // green
  cooling: "pending", // amber
  cold: "bug", // orange
};

const BAND_LABEL: Record<HealthBand, string> = {
  active: "active",
  cooling: "cooling",
  cold: "cold",
};

/**
 * Small pill showing a pinned project's momentum band (see
 * lib/portfolio.ts#computeRepoHealth). The full reason is the hover title so
 * the driver is available without cluttering the card.
 */
export function HealthBadge({ health, className }: { health: RepoHealth; className?: string }) {
  return (
    <span title={health.reason}>
      <StatusBadge tone={BAND_TONE[health.band]} className={className}>
        {BAND_LABEL[health.band]}
      </StatusBadge>
    </span>
  );
}
