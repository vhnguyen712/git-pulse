import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionItems, type ActionItem } from "@/lib/db/schema";
import { createIssue } from "@/lib/github";

function issueBody(description: string | null, source: string): string {
  const kind = source === "next_step" ? "Next step" : "Brainstorm idea";
  return `${description ?? ""}\n\n---\n_Suggested by GitPulse AI (${kind})._`;
}

export type PublishResult =
  | { ok: true; actionItem: ActionItem; created: boolean }
  | { ok: false; code: "not_found" | "dismissed" | "no_project"; message: string };

/**
 * Publishes an action item to GitHub as an issue and marks it `synced`.
 * Idempotent: an already-`synced` item is returned as-is (created: false)
 * instead of filing a duplicate; a `dismissed` item is rejected. Shared by
 * the POST /api/issues route and the `publish_issue` MCP tool so there is
 * one implementation of the push flow.
 */
export async function publishActionItem(actionItemId: string): Promise<PublishResult> {
  const item = await db.query.actionItems.findFirst({
    where: (a, { eq }) => eq(a.id, actionItemId),
  });
  if (!item) {
    return { ok: false, code: "not_found", message: "Action item not found." };
  }
  if (item.status === "synced") {
    return { ok: true, actionItem: item, created: false };
  }
  if (item.status === "dismissed") {
    return {
      ok: false,
      code: "dismissed",
      message: "This item was dismissed and can't be pushed.",
    };
  }

  const project = await db.query.projects.findFirst({
    where: (p, { eq }) => eq(p.id, item.projectId),
  });
  if (!project) {
    return { ok: false, code: "no_project", message: "Project not found." };
  }

  const issue = await createIssue(
    project.owner,
    project.repoName,
    item.title,
    issueBody(item.description, item.source),
  );

  const [updated] = await db
    .update(actionItems)
    .set({
      status: "synced",
      githubIssueNumber: issue.number,
      githubIssueUrl: issue.htmlUrl,
    })
    .where(eq(actionItems.id, item.id))
    .returning();

  return { ok: true, actionItem: updated, created: true };
}
