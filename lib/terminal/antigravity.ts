import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@/lib/logging";

const SETTINGS_PATH = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");

interface AntigravitySettings {
  trustedWorkspaces?: string[];
  [key: string]: unknown;
}

/**
 * Antigravity CLI (agy) shows a one-time "Do you trust the contents of this
 * project?" prompt the first time it's launched in a directory. Every
 * embedded-terminal session runs in its own freshly created git worktree
 * (see worktree.ts) with a unique path, so without this every single session
 * would hit that prompt — and since it's a keystroke-driven menu, not a text
 * field, the seeded task prompt we write right after spawn (see attachTerminal)
 * gets swallowed by it instead of landing in agy's actual input.
 *
 * agy persists trust decisions as a flat list of absolute paths in
 * `~/.gemini/antigravity-cli/settings.json` -> `trustedWorkspaces` (confirmed
 * by inspecting that file after manually trusting a couple of worktrees; no
 * documented CLI flag or env var does this as of 2026-08). Pre-adding the
 * worktree path here before spawn makes agy skip the prompt outright.
 * Best-effort — any failure here just falls back to agy's own prompt.
 */
export function trustAntigravityWorkspace(workspacePath: string): void {
  try {
    let settings: AntigravitySettings = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
      } catch {
        // Malformed file — best-effort, start fresh rather than blocking spawn.
      }
    }
    const trusted = new Set(settings.trustedWorkspaces ?? []);
    if (trusted.has(workspacePath)) return;
    trusted.add(workspacePath);
    settings.trustedWorkspaces = [...trusted];

    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    logger.error("Failed to pre-trust Antigravity workspace", err);
  }
}
