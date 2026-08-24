import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Renders developer-originated content (SHAs, file paths, code, terminal
 * output) in JetBrains Mono, per the design spec's "Technical Mono" rule.
 */
export function MonoText({
  children,
  as: Component = "span",
  size = "base",
  muted = false,
  className,
}: {
  children: ReactNode;
  as?: ElementType;
  size?: "base" | "sm";
  muted?: boolean;
  className?: string;
}) {
  return (
    <Component
      className={cn(
        "font-mono",
        size === "base" ? "text-[13px] leading-5" : "text-[11px] leading-[14px]",
        muted ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      {children}
    </Component>
  );
}

/** Truncates a git SHA to its short (7-char) form for display. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
