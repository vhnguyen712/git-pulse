import { db } from "@/lib/db";
import type { Analysis } from "@/lib/schema";
import { resolveSettings } from "@/lib/settings";
import { estimateCostUsd } from "@/lib/runs/cost";

export interface SyncHistoryEntry {
  id: string;
  createdAt: number;
  baseSha: string;
  headSha: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** null when usage wasn't recorded, or no per-token pricing is configured in Settings. */
  estimatedCostUsd: number | null;
  counts: {
    achievements: number;
    fixesAndRefactoring: number;
    architecturalChanges: number;
    nextSteps: number;
    brainstormIdeas: number;
  };
  /** Current status of items that came out of this summary — not a point-in-time snapshot, reflects outcomes since. */
  itemStatusCounts: {
    suggested: number;
    approved: number;
    synced: number;
    dismissed: number;
  };
}

/** The whole project's summary prose, accumulated across every sync. */
export interface ProjectSummaryData {
  achievements: string[];
  fixesAndRefactoring: string[];
  architecturalChanges: string[];
  /** Number of summaries aggregated, for a subtitle like "across N syncs". */
  syncCount: number;
}

/** Drop exact duplicates (case-insensitive, trimmed), keeping the first occurrence. */
export function dedupeStrings(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * The AI Core Insights tab shows only the latest sync's summary prose. This
 * aggregates the same three lists across *every* sync — newest-first, exact
 * duplicates removed — for the centralized "Project Summary" tab. All the raw
 * data already lives in `ai_summaries.summaryJson`; nothing is regenerated.
 */
export async function getProjectSummary(projectId: string): Promise<ProjectSummaryData> {
  const summaries = await db.query.aiSummaries.findMany({
    where: (s, { eq }) => eq(s.projectId, projectId),
    orderBy: (s, { desc }) => desc(s.createdAt),
  });

  const achievements: string[] = [];
  const fixesAndRefactoring: string[] = [];
  const architecturalChanges: string[] = [];

  for (const s of summaries) {
    const analysis = JSON.parse(s.summaryJson) as Analysis;
    achievements.push(...analysis.summary.key_achievements);
    fixesAndRefactoring.push(...analysis.summary.fixes_and_refactoring);
    architecturalChanges.push(...analysis.summary.architectural_changes);
  }

  return {
    achievements: dedupeStrings(achievements),
    fixesAndRefactoring: dedupeStrings(fixesAndRefactoring),
    architecturalChanges: dedupeStrings(architecturalChanges),
    syncCount: summaries.length,
  };
}

/**
 * Every past analysis for a project, oldest first — powers the History
 * timeline (roadmap #1). lib/workspace.ts only loads the single latest
 * summary for the main workspace view; this is the complement that surfaces
 * everything else already sitting in `ai_summaries`.
 */
export async function getProjectHistory(projectId: string): Promise<SyncHistoryEntry[]> {
  const [summaries, { costPerMillionInput, costPerMillionOutput }] = await Promise.all([
    db.query.aiSummaries.findMany({
      where: (s, { eq }) => eq(s.projectId, projectId),
      orderBy: (s, { asc }) => asc(s.createdAt),
    }),
    resolveSettings(),
  ]);
  const pricing = { costPerMillionInput, costPerMillionOutput };

  const items = await db.query.actionItems.findMany({
    where: (a, { eq }) => eq(a.projectId, projectId),
  });
  const itemsBySummary = new Map<string, typeof items>();
  for (const item of items) {
    if (!item.summaryId) continue;
    const list = itemsBySummary.get(item.summaryId) ?? [];
    list.push(item);
    itemsBySummary.set(item.summaryId, list);
  }

  return summaries.map((s) => {
    const analysis = JSON.parse(s.summaryJson) as Analysis;
    const summaryItems = itemsBySummary.get(s.id) ?? [];

    const estimatedCostUsd = estimateCostUsd(s.promptTokens, s.completionTokens, pricing);

    return {
      id: s.id,
      createdAt: s.createdAt,
      baseSha: s.baseSha,
      headSha: s.headSha,
      model: s.model,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      totalTokens: s.totalTokens,
      estimatedCostUsd,
      counts: {
        achievements: analysis.summary.key_achievements.length,
        fixesAndRefactoring: analysis.summary.fixes_and_refactoring.length,
        architecturalChanges: analysis.summary.architectural_changes.length,
        nextSteps: analysis.next_steps.length,
        brainstormIdeas: analysis.brainstorm_ideas.length,
      },
      itemStatusCounts: {
        suggested: summaryItems.filter((i) => i.status === "suggested").length,
        approved: summaryItems.filter((i) => i.status === "approved").length,
        synced: summaryItems.filter((i) => i.status === "synced").length,
        dismissed: summaryItems.filter((i) => i.status === "dismissed").length,
      },
    };
  });
}
