import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionItems, type ActionItem, type Project } from "@/lib/db/schema";
import {
  listOpenPullRequests,
  listBranches,
  createDraftPullRequest,
  getPullRequest,
  getPullRequestMergeStatus,
  type PullRequestSummary,
} from "@/lib/github";
import { branchNameForItem, actionItemIdFromBranch } from "@/lib/pull-branch";
import { logger } from "@/lib/logging";

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
  const openPrNumbers = new Set(pulls.map((pr) => pr.number));

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

  await reconcileFinishedPullRequests(project, openPrNumbers);

  return pulls;
}

/**
 * Follow-up for PRs that fell out of the open list — the only way a PR
 * leaves listOpenPullRequests() is by merging or closing, but that state
 * change was previously never written back (see historical bug: cards kept
 * showing "draft" forever after merge). Finds items still recorded as
 * draft/open whose PR isn't in the current open set, looks each one up
 * individually, and writes the real state — flipping the item to "shipped"
 * when its PR merged.
 */
async function reconcileFinishedPullRequests(
  project: Project,
  openPrNumbers: Set<number>,
): Promise<void> {
  const staleItems = await db.query.actionItems.findMany({
    where: (a, { and, eq, isNotNull, inArray }) =>
      and(
        eq(a.projectId, project.id),
        isNotNull(a.githubPrNumber),
        inArray(a.githubPrState, ["draft", "open"]),
      ),
  });

  for (const item of staleItems) {
    if (!item.githubPrNumber || openPrNumbers.has(item.githubPrNumber)) continue;

    const pr = await getPullRequest(project.owner, project.repoName, item.githubPrNumber);
    if (pr.state === "open") continue; // still open, just missed this page — leave as-is

    await db
      .update(actionItems)
      .set({
        githubPrState: pr.merged ? "merged" : "closed",
        status: pr.merged ? "shipped" : item.status,
      })
      .where(eq(actionItems.id, item.id));
  }
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

/** A `gitpulse/<id>` branch whose open PR conflicts with the base branch. */
export interface ConflictInfo {
  actionItemId: string;
  branch: string;
  baseBranch: string;
  prNumber: number;
  prUrl: string;
}

/**
 * Checks each action item's open/draft PR for merge conflicts against the
 * base branch (GitHub's `mergeable_state: "dirty"`). Only ever called for
 * items GitPulse itself pushed a `gitpulse/<id>` branch for, since that's a
 * bounded, small set — unlike open PRs generally, which could be many and
 * unrelated. Feeds the workspace's conflict banner + "Resolve with agent"
 * flow (components/action-item-card.tsx), which offers an LLM-assisted
 * resolution in the embedded terminal instead of leaving the user to
 * untangle it with raw git.
 */
export async function getConflictingPrs(
  project: Project,
  items: ActionItem[],
): Promise<ConflictInfo[]> {
  const candidates = items.filter(
    (item): item is ActionItem & { githubPrNumber: number; githubPrUrl: string } =>
      item.githubPrNumber != null &&
      item.githubPrUrl != null &&
      (item.githubPrState === "draft" || item.githubPrState === "open"),
  );
  if (candidates.length === 0) return [];

  const results = await Promise.all(
    candidates.map(async (item) => {
      try {
        const status = await getPullRequestMergeStatus(
          project.owner,
          project.repoName,
          item.githubPrNumber,
        );
        if (status.mergeableState !== "dirty") return null;
        return {
          actionItemId: item.id,
          branch: branchNameForItem(item.id),
          baseBranch: project.defaultBranch,
          prNumber: item.githubPrNumber,
          prUrl: item.githubPrUrl,
        } satisfies ConflictInfo;
      } catch (err) {
        logger.error(`getPullRequestMergeStatus failed for PR #${item.githubPrNumber}`, err);
        return null;
      }
    }),
  );
  return results.filter((r): r is ConflictInfo => r !== null);
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
