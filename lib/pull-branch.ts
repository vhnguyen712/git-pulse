/**
 * Deterministic branch-naming convention that links a `gitpulse/*` branch
 * back to the action item it was created for — the sole mechanism GitPulse
 * uses to associate a pushed branch (and the PR opened from it) with a card.
 *
 * Kept dependency-free (no `db`, no Octokit) so it's safe to import from
 * both the client (components/action-item-card.tsx, to seed the terminal
 * prompt) and the server (lib/pulls.ts, to reconcile PRs).
 */
export const GITPULSE_BRANCH_PREFIX = "gitpulse/";

/**
 * Branch name GitPulse tells Claude to create for a given action item.
 * `actionItemId` is a `crypto.randomUUID()` (chars `[0-9a-f-]`), so this is
 * already git-ref-safe and filesystem-safe with no sanitization needed.
 */
export function branchNameForItem(actionItemId: string): string {
  return `${GITPULSE_BRANCH_PREFIX}${actionItemId}`;
}

/** Inverse of branchNameForItem — null if `headRef` isn't one of ours. */
export function actionItemIdFromBranch(headRef: string): string | null {
  return headRef.startsWith(GITPULSE_BRANCH_PREFIX)
    ? headRef.slice(GITPULSE_BRANCH_PREFIX.length)
    : null;
}
