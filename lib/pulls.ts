import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionItems, type ActionItem, type Project } from "@/lib/db/schema";
import {
  listOpenPullRequests,
  listBranches,
  createDraftPullRequest,
  type PullRequestSummary,
} from "@/lib/github";
import { branchNameForItem, actionItemIdFromBranch } from "@/lib/pull-branch";

/** A `gitpulse/<id>` branch that's pushed but doesn't have a PR yet. */
export interface PrCandidate {
  actionItemId: string;
  title: string;
  branch: string;
}

/**
 * Fetches the repo's open PRs and write-through records any that were
 * opened for one of our action items onto that item's `githubPr*` columns —
 * so the card's "View PR" link renders on the next server render and
 * survives the PR leaving the open-PR list (merged/closed). Deliberately
 * never clears the columns: durability over freshness. Shared by
 * getWorkspaceData (server render) and GET /api/pulls (client refresh) so
 * matching lives in one place.
 */
export async function reconcilePullRequests(project: Project): Promise<PullRequestSummary[]> {
  const pulls = await listOpenPullRequests(project.owner, project.repoName);

  for (const pr of pulls) {
    const actionItemId = actionItemIdFromBranch(pr.headRef);
    if (!actionItemId) continue;
    await db
      .update(actionItems)
      .set({
        githubPrNumber: pr.number,
        githubPrUrl: pr.htmlUrl,
        githubPrState: pr.isDraft ? "draft" : "open",
      })
      .where(eq(actionItems.id, actionItemId));
  }

  return pulls;
}

/**
 * `gitpulse/<id>` branches that exist on GitHub but don't yet have an open
 * PR (and haven't already been recorded as one, e.g. a merged/closed PR we
 * don't want to reopen automatically) — surfaced as the "Ready to open"
 * list so the user can trigger PR creation with one click.
 */
export async function getPrCandidates(
  project: Project,
  openPulls: PullRequestSummary[],
  items: ActionItem[],
): Promise<PrCandidate[]> {
  const branches = await listBranches(project.owner, project.repoName);
  const openHeadRefs = new Set(openPulls.map((pr) => pr.headRef));
  const itemsById = new Map(items.map((item) => [item.id, item]));

  const candidates: PrCandidate[] = [];
  for (const branch of branches) {
    const actionItemId = actionItemIdFromBranch(branch);
    if (!actionItemId) continue;
    if (openHeadRefs.has(branch)) continue; // already has an open PR
    const item = itemsById.get(actionItemId);
    if (!item || item.githubPrUrl) continue; // unknown item, or PR already recorded
    candidates.push({ actionItemId, title: item.title, branch });
  }
  return candidates;
}

function prBody(item: ActionItem): string {
  const lines = [item.description ?? ""];
  if (item.githubIssueNumber) lines.push("", `Closes #${item.githubIssueNumber}`);
  lines.push("", "---", "_Opened by GitPulse AI._");
  return lines.join("\n");
}

export type OpenPrResult =
  | { ok: true; actionItem: ActionItem; created: boolean }
  | { ok: false; code: "not_found" | "no_project" | "no_branch"; message: string };

/**
 * Opens a draft PR for an action item's `gitpulse/<id>` branch, base = the
 * repo's default branch. Idempotent — an item that already has a recorded
 * PR is returned as-is (created: false) rather than opening a duplicate.
 * Shared by POST /api/pulls and the `open_pull_request` MCP tool, mirroring
 * how lib/issues.ts#publishActionItem backs both the issues route and the
 * `publish_issue` MCP tool.
 */
export async function openDraftPullRequest(actionItemId: string): Promise<OpenPrResult> {
  const item = await db.query.actionItems.findFirst({
    where: (a, { eq }) => eq(a.id, actionItemId),
  });
  if (!item) {
    return { ok: false, code: "not_found", message: "Action item not found." };
  }
  if (item.githubPrUrl) {
    return { ok: true, actionItem: item, created: false };
  }

  const project = await db.query.projects.findFirst({
    where: (p, { eq }) => eq(p.id, item.projectId),
  });
  if (!project) {
    return { ok: false, code: "no_project", message: "Project not found." };
  }

  const head = branchNameForItem(item.id);
  try {
    const pr = await createDraftPullRequest(
      project.owner,
      project.repoName,
      head,
      project.defaultBranch,
      item.title,
      prBody(item),
    );

    const [updated] = await db
      .update(actionItems)
      .set({
        githubPrNumber: pr.number,
        githubPrUrl: pr.htmlUrl,
        githubPrState: pr.isDraft ? "draft" : "open",
      })
      .where(eq(actionItems.id, item.id))
      .returning();

    return { ok: true, actionItem: updated, created: true };
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { status?: number }).status === 422) {
      return {
        ok: false,
        code: "no_branch",
        message: `Branch "${head}" doesn't exist yet or has no commits ahead of ${project.defaultBranch}.`,
      };
    }
    throw err;
  }
}
