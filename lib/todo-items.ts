import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionItems } from "@/lib/db/schema";
import type { ActionItem } from "@/lib/db/schema";
import { scanRepoTodos, type TodoFinding } from "@/lib/todo-scan";

export class TodoScanProjectNotFoundError extends Error {}

const TITLE_MAX = 120;

function basename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1];
}

/**
 * Deterministic card title for a finding. Encodes the marker plus either its
 * description text or, for a bare marker, the file it lives in. Two scans of
 * the same marker produce the same title, which is what makes re-scans
 * idempotent (see scanAndPersistTodos) and keeps a marker that merely shifts
 * lines from being re-added.
 */
export function todoTitle(finding: TodoFinding): string {
  if (finding.text) {
    const text =
      finding.text.length > TITLE_MAX ? `${finding.text.slice(0, TITLE_MAX - 1)}…` : finding.text;
    return `${finding.marker}: ${text}`;
  }
  return `${finding.marker} in ${basename(finding.file)}`;
}

export interface TodoScanPersistResult {
  scanned: number;
  found: number;
  /** How many new action items were created (excludes ones already tracked). */
  added: number;
  truncated: boolean;
  items: ActionItem[];
}

/**
 * Scans a pinned project's repo for TODO/FIXME/HACK/XXX markers and records
 * new ones as `source: "todo"` action items. Idempotent: a marker already
 * tracked (same generated title) is skipped, so re-scanning only surfaces
 * markers added since. Returns the project's full item list so the caller can
 * refresh the board.
 */
export async function scanAndPersistTodos(
  owner: string,
  repo: string,
  branch?: string,
): Promise<TodoScanPersistResult> {
  const project = await db.query.projects.findFirst({
    where: (p, { and, eq }) => and(eq(p.owner, owner), eq(p.repoName, repo)),
  });
  if (!project) {
    throw new TodoScanProjectNotFoundError(
      "Project not found. Sync it once before scanning for TODOs.",
    );
  }

  const targetBranch = branch ?? project.syncBranch ?? project.defaultBranch;
  const scan = await scanRepoTodos(owner, repo, targetBranch);

  // Titles already tracked for this project — the idempotency guard.
  const existing = await db
    .select({ title: actionItems.title })
    .from(actionItems)
    .where(and(eq(actionItems.projectId, project.id), eq(actionItems.source, "todo")));
  const seenTitles = new Set(existing.map((r) => r.title));

  const toInsert = [];
  for (const finding of scan.findings) {
    const title = todoTitle(finding);
    if (seenTitles.has(title)) continue;
    seenTitles.add(title); // also dedupes within this scan
    toInsert.push({
      id: crypto.randomUUID(),
      projectId: project.id,
      source: "todo" as const,
      title,
      description: `In \`${finding.file}\` (line ${finding.line})`,
      category: finding.marker.toLowerCase(),
      priority: "medium" as const,
      status: "suggested" as const,
    });
  }

  if (toInsert.length > 0) {
    await db.insert(actionItems).values(toInsert);
  }

  const items = await db.query.actionItems.findMany({
    where: (a, { eq }) => eq(a.projectId, project.id),
    orderBy: (a, { desc }) => desc(a.createdAt),
  });

  return {
    scanned: scan.filesScanned,
    found: scan.findings.length,
    added: toInsert.length,
    truncated: scan.truncated,
    items,
  };
}
