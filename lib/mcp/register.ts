import { z } from "zod";
import { eq } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "@/lib/db";
import { actionItems } from "@/lib/db/schema";
import { publishActionItem } from "@/lib/issues";
import { openDraftPullRequest } from "@/lib/pulls";
import { startRun } from "@/lib/runs/runner";
import { runConfigSchema } from "@/lib/schema";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Registers GitPulse's MCP tools on a server instance. Shared by both
 * transports (mcp/stdio.ts for local Claude Code, app/api/mcp/route.ts for
 * remote/HTTP agents) so the tool logic exists in exactly one place.
 */
export function registerGitPulseTools(server: McpServer) {
  server.registerTool(
    "list_projects",
    { description: "List repositories pinned to GitPulse's dashboard." },
    async () => json(await db.query.projects.findMany()),
  );

  server.registerTool(
    "list_action_items",
    {
      description:
        "List AI-suggested action items (next steps / brainstorm ideas). Optionally filter by project, status, priority, or source.",
      inputSchema: z.object({
        projectId: z.string().optional().describe("Only items for this project id."),
        status: z
          .enum(["suggested", "approved", "synced", "shipped", "dismissed"])
          .optional()
          .describe("Only items in this status."),
        priority: z.enum(["high", "medium", "low"]).optional(),
        source: z.enum(["next_step", "brainstorm"]).optional(),
      }),
    },
    async ({ projectId, status, priority, source }) => {
      const rows = await db.query.actionItems.findMany({
        where: (a, { and, eq }) =>
          and(
            projectId ? eq(a.projectId, projectId) : undefined,
            status ? eq(a.status, status) : undefined,
            priority ? eq(a.priority, priority) : undefined,
            source ? eq(a.source, source) : undefined,
          ),
      });
      return json(rows);
    },
  );

  server.registerTool(
    "get_action_item",
    {
      description: "Get a single action item, including its full description.",
      inputSchema: z.object({ actionItemId: z.string() }),
    },
    async ({ actionItemId }) => {
      const item = await db.query.actionItems.findFirst({
        where: (a, { eq }) => eq(a.id, actionItemId),
      });
      return json(item ?? { error: "not_found" });
    },
  );

  server.registerTool(
    "publish_issue",
    {
      description:
        "Publish an action item to GitHub as an issue and mark it synced. Idempotent — calling it again on an already-synced item returns the existing issue instead of creating a duplicate.",
      inputSchema: z.object({ actionItemId: z.string() }),
    },
    async ({ actionItemId }) => json(await publishActionItem(actionItemId)),
  );

  server.registerTool(
    "open_pull_request",
    {
      description:
        "Open a draft PR for an action item's gitpulse/<id> branch (push the branch first — e.g. `git push -u origin gitpulse/<id>`). Idempotent — calling it again on an item that already has a PR returns the existing PR instead of opening a duplicate. Only reachable when GitPulse's MCP server is registered in the target repo; otherwise the user can trigger this from the workspace's Pull Requests tab instead.",
      inputSchema: z.object({ actionItemId: z.string() }),
    },
    async ({ actionItemId }) => json(await openDraftPullRequest(actionItemId)),
  );

  server.registerTool(
    "update_action_item_status",
    {
      description:
        "Change an action item's status — approve it, dismiss it, or move it back to suggested.",
      inputSchema: z.object({
        actionItemId: z.string(),
        status: z.enum(["suggested", "approved", "dismissed"]),
      }),
    },
    async ({ actionItemId, status }) => {
      const [row] = await db
        .update(actionItems)
        .set({ status })
        .where(eq(actionItems.id, actionItemId))
        .returning();
      return json(row ?? { error: "not_found" });
    },
  );

  server.registerTool(
    "start_run",
    {
      description:
        "Start an instrumented agent run: spawns the given agent CLI in a dedicated git worktree, records its token usage/cost/tool-use as a step timeline (visible in the workspace's Runs tab), and optionally runs the repo's own test/lint/build afterward (config.verify) — no extra agent tokens spent on that step. Returns immediately with a runId; the run continues in the background. Poll get_run for status, or watch the Runs tab.",
      inputSchema: z.object({
        projectId: z.string(),
        actionItemId: z.string().optional().describe("Ties the run to an action item's gitpulse/<id> branch."),
        agentId: z.string().describe('e.g. "claude", "codex", "antigravity" — see lib/terminal/agents.ts.'),
        config: runConfigSchema,
      }),
    },
    async ({ projectId, actionItemId, agentId, config }) =>
      json(await startRun({ projectId, actionItemId, agentId, config })),
  );

  server.registerTool(
    "get_run",
    {
      description: "Get one run's current status/totals plus its full step timeline, oldest first.",
      inputSchema: z.object({ runId: z.string() }),
    },
    async ({ runId }) => {
      const run = await db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, runId) });
      if (!run) return json({ error: "not_found" });
      const steps = await db.query.runSteps.findMany({
        where: (s, { eq }) => eq(s.runId, runId),
        orderBy: (s, { asc }) => asc(s.seq),
      });
      return json({ run, steps });
    },
  );

  server.registerTool(
    "list_runs",
    {
      description: "List instrumented agent runs. Optionally filter by project or action item.",
      inputSchema: z.object({
        projectId: z.string().optional(),
        actionItemId: z.string().optional(),
      }),
    },
    async ({ projectId, actionItemId }) => {
      const rows = await db.query.runs.findMany({
        where: (r, { and, eq }) =>
          and(
            projectId ? eq(r.projectId, projectId) : undefined,
            actionItemId ? eq(r.actionItemId, actionItemId) : undefined,
          ),
        orderBy: (r, { desc }) => desc(r.createdAt),
      });
      return json(rows);
    },
  );
}
