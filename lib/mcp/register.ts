import { z } from "zod";
import { eq } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "@/lib/db";
import { actionItems } from "@/lib/db/schema";
import { publishActionItem } from "@/lib/issues";

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
          .enum(["suggested", "approved", "synced", "dismissed"])
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
}
