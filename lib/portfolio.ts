import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionItems, aiSummaries } from "@/lib/db/schema";
import type { RepoCardData } from "@/lib/repos";

const DAY_MS = 24 * 60 * 60 * 1000;
/** At or under this many days since the last push, a project scores a perfect 100. */
const FRESH_DAYS = 7;
/** At or over this many days since the last push, a project bottoms out at 0. */
const COLD_DAYS = 60;

/** Health band for a pinned project — a coarse bucket over the 0–100 score. */
export type HealthBand = "active" | "cooling" | "cold";

export interface RepoHealth {
  /** 0 (stone cold) – 100 (freshly active). */
  score: number;
  band: HealthBand;
  /** Short human-readable driver of the band, e.g. "no commits in 42 days · 3 open suggestions". */
  reason: string;
}

/** A pinned project ranked as going cold, for the Overview's "Going cold" strip. */
export interface ColdProject {
  fullName: string;
  health: RepoHealth;
}

export interface PortfolioSummary {
  pinnedCount: number;
  staleCount: number;
  openActionItems: number;
  shippedActionItems: number;
  totalTokens: number;
  mostActiveRepo: { fullName: string; newItemCount: number } | null;
  /** Lowest-health pinned projects (cooling/cold), coldest first — empty when all are active. */
  coldProjects: ColdProject[];
}

function bandFor(score: number): HealthBand {
  if (score >= 67) return "active";
  if (score >= 34) return "cooling";
  return "cold";
}

/**
 * Momentum score for a single pinned project, from data getRepoCards() already
 * has — no extra GitHub calls. Push recency is the primary driver (a project
 * you haven't committed to in weeks is going cold); a backlog of open,
 * unaddressed suggestions is surfaced in the reason so the coldest projects
 * with neglected work stand out.
 */
export function computeRepoHealth(input: {
  pushedAt: string | null;
  openItemCount: number;
  now?: number;
}): RepoHealth {
  const now = input.now ?? Date.now();
  const pushedMs = input.pushedAt ? new Date(input.pushedAt).getTime() : null;
  const days =
    pushedMs != null && !Number.isNaN(pushedMs)
      ? Math.max(0, Math.floor((now - pushedMs) / DAY_MS))
      : null;

  let score: number;
  if (days == null) {
    score = 0;
  } else if (days <= FRESH_DAYS) {
    score = 100;
  } else if (days >= COLD_DAYS) {
    score = 0;
  } else {
    score = Math.round((100 * (COLD_DAYS - days)) / (COLD_DAYS - FRESH_DAYS));
  }

  const band = bandFor(score);

  const parts: string[] = [];
  if (days == null) {
    parts.push("no push activity recorded");
  } else if (band === "active") {
    parts.push(days <= 1 ? "pushed today" : `pushed ${days} days ago`);
  } else {
    parts.push(`no commits in ${days} days`);
  }
  if (input.openItemCount > 0) {
    parts.push(`${input.openItemCount} open suggestion${input.openItemCount === 1 ? "" : "s"}`);
  }

  return { score, band, reason: parts.join(" · ") };
}

/**
 * Portfolio-level rollup for the Overview page (roadmap #5) — reuses the
 * repo cards already fetched by getRepoCards() (lib/repos.ts) instead of
 * making a second GitHub call, and adds cheap local-DB aggregates on top.
 */
export async function getPortfolioSummary(repoCards: RepoCardData[]): Promise<PortfolioSummary> {
  const pinned = repoCards.filter((r) => r.pinned);
  const staleCount = pinned.filter((r) => r.hasUnanalyzedChanges).length;

  const [openRows, shippedRows, tokenRows] = await Promise.all([
    db
      .select({ id: actionItems.id })
      .from(actionItems)
      .where(inArray(actionItems.status, ["suggested", "approved"])),
    db
      .select({ id: actionItems.id })
      .from(actionItems)
      .where(inArray(actionItems.status, ["synced"])),
    db.select({ totalTokens: aiSummaries.totalTokens }).from(aiSummaries),
  ]);

  const totalTokens = tokenRows.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);

  const mostActive = pinned.reduce<RepoCardData | null>((best, r) => {
    if (r.newItemCount === 0) return best;
    if (!best || r.newItemCount > best.newItemCount) return r;
    return best;
  }, null);

  // Per-card health is computed once in getRepoCards(); here we just rank the
  // pinned projects that aren't fully active, coldest first.
  const coldProjects: ColdProject[] = pinned
    .filter((r): r is RepoCardData & { health: RepoHealth } =>
      Boolean(r.health) && r.health!.band !== "active",
    )
    .map((r) => ({ fullName: r.fullName, health: r.health }))
    .sort((a, b) => a.health.score - b.health.score)
    .slice(0, 5);

  return {
    pinnedCount: pinned.length,
    staleCount,
    openActionItems: openRows.length,
    shippedActionItems: shippedRows.length,
    totalTokens,
    mostActiveRepo: mostActive
      ? { fullName: mostActive.fullName, newItemCount: mostActive.newItemCount }
      : null,
    coldProjects,
  };
}
