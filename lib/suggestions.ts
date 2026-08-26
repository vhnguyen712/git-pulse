import { db } from "@/lib/db";
import type { ActionItem, Project } from "@/lib/db/schema";

export interface SuggestionsData {
  projects: Project[];
  items: ActionItem[];
}

/**
 * Loads every action item across every pinned project, for the cross-repo
 * Suggestions dashboard. Deliberately makes no GitHub calls — it reads
 * whatever `githubIssue*`/`githubPr*` state was last reconciled onto each row
 * (see lib/pulls.ts#reconcilePullRequests, which runs per-project from the
 * workspace) rather than re-fetching every repo's PRs here, so opening the
 * dashboard stays cheap and doesn't multiply GitHub rate-limit usage across
 * however many repos are pinned.
 */
export async function getAllSuggestions(): Promise<SuggestionsData> {
  const [projects, items] = await Promise.all([
    db.query.projects.findMany(),
    db.query.actionItems.findMany({
      orderBy: (a, { desc }) => desc(a.createdAt),
    }),
  ]);
  return { projects, items };
}
