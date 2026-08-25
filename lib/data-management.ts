import { db } from "@/lib/db";
import { projects, settings } from "@/lib/db/schema";
import { logger } from "@/lib/logging";

export interface ClearDataOptions {
  clearSettings: boolean;
  clearSyncData: boolean;
}

/**
 * Wipes local app data on request from the Settings page's Danger Zone.
 * "Sync data" = pinned projects, which cascades (ON DELETE CASCADE) to their
 * ai_summaries and action_items — deleting from `projects` is enough.
 * "Settings data" = the single settings row (GitHub token, LLM config, etc).
 */
export async function clearAppData({
  clearSettings,
  clearSyncData,
}: ClearDataOptions): Promise<void> {
  if (clearSyncData) {
    await db.delete(projects);
  }
  if (clearSettings) {
    await db.delete(settings);
  }
  logger.info("Cleared local data", { clearSettings, clearSyncData });
}
