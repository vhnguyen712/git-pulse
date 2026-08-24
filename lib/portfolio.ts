import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionItems, aiSummaries } from "@/lib/db/schema";
import type { RepoCardData } from "@/lib/repos";

export interface PortfolioSummary {
  pinnedCount: number;
  staleCount: number;
  openActionItems: number;
  shippedActionItems: number;
  totalTokens: number;
  mostActiveRepo: { fullName: string; newItemCount: number } | null;
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

  return {
    pinnedCount: pinned.length,
    staleCount,
    openActionItems: openRows.length,
    shippedActionItems: shippedRows.length,
    totalTokens,
    mostActiveRepo: mostActive
      ? { fullName: mostActive.fullName, newItemCount: mostActive.newItemCount }
      : null,
  };
}
