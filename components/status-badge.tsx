import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Semantic categories mapped from `action_items.category` / `.priority` / `.status`.
 * Colors are the design system's semantic accents (blue/orange/purple/green/amber) —
 * these are NOT part of the canonical grayscale token set and are used sparingly,
 * for badges only.
 */
export type BadgeTone =
  | "feature" // blue
  | "bug" // orange
  | "refactor" // purple — also covers "architecture"
  | "synced" // green — also covers "active"/"high" priority
  | "pending"; // amber — also covers "unanalyzed"/"medium" priority

const TONE_CLASSES: Record<BadgeTone, string> = {
  feature: "text-accent-blue bg-accent-blue-bg",
  bug: "text-accent-orange bg-accent-orange-bg",
  refactor: "text-accent-purple bg-accent-purple-bg",
  synced: "text-accent-green bg-accent-green-bg",
  pending: "text-accent-amber bg-accent-amber-bg",
};

/** Maps action_items.category values to a badge tone. */
export function toneFromCategory(category: string): BadgeTone {
  switch (category) {
    case "feature":
      return "feature";
    case "bug":
      return "bug";
    case "refactor":
    case "architecture":
      return "refactor";
    case "performance":
      return "pending";
    case "enhancement":
      return "feature";
    default:
      return "pending";
  }
}

/** Maps action_items.priority values to a badge tone. */
export function toneFromPriority(priority: "high" | "medium" | "low"): BadgeTone {
  if (priority === "high") return "bug";
  if (priority === "medium") return "pending";
  return "refactor";
}

/** Maps action_items.status values to a badge tone. */
export function toneFromStatus(
  status: "suggested" | "approved" | "synced" | "shipped" | "dismissed",
): BadgeTone {
  if (status === "synced" || status === "shipped") return "synced";
  if (status === "dismissed") return "refactor";
  return "pending";
}

export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium leading-none",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
