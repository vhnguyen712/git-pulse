import type { RunStatus } from "@/lib/runs/types";
import { StatusBadge, type BadgeTone } from "@/components/status-badge";
import { PulseIndicator } from "@/components/pulse-indicator";

const TONE: Record<RunStatus, BadgeTone> = {
  queued: "pending",
  running: "feature",
  paused: "pending",
  awaiting_approval: "pending",
  verifying: "feature",
  done: "synced",
  failed: "bug",
  cancelled: "refactor",
};

const LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  awaiting_approval: "Awaiting approval",
  verifying: "Verifying",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const LIVE: ReadonlySet<RunStatus> = new Set(["running", "verifying"]);

/** Status pill for a run, with the live pulse dot while it's actively working. */
export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {LIVE.has(status) && <PulseIndicator state="processing" />}
      <StatusBadge tone={TONE[status]} className={className}>
        {LABEL[status]}
      </StatusBadge>
    </span>
  );
}
