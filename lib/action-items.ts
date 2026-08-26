import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionItems } from "@/lib/db/schema";

/**
 * Permanently deletes a local action-item row. Local-only: any GitHub issue
 * or pull request already created from the item is left untouched — this
 * just stops GitPulse from tracking the suggestion. Shared by
 * DELETE /api/action-items so the Suggestions dashboard and the per-repo
 * workspace's "Remove" button use the same implementation.
 */
export async function deleteActionItem(actionItemId: string): Promise<boolean> {
  const deleted = await db
    .delete(actionItems)
    .where(eq(actionItems.id, actionItemId))
    .returning({ id: actionItems.id });
  return deleted.length > 0;
}
