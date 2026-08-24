import { createMcpHandler } from "mcp-handler";
import { registerGitPulseTools } from "@/lib/mcp/register";
import { resolveSettings } from "@/lib/settings";

/**
 * Streamable HTTP MCP endpoint for remote/non-local agents (e.g. Codex).
 * Local agents on this machine should prefer the stdio transport
 * (mcp/stdio.ts) instead — it needs no token and talks to the DB directly.
 *
 * Guarded with the same shared-secret pattern as POST /api/cron/sync: the
 * caller must send `Authorization: Bearer <cronSecret>`, using the secret
 * configured on the Settings page (or CRON_SECRET in .env.local).
 */
const handler = createMcpHandler((server) => registerGitPulseTools(server), {
  serverInfo: { name: "gitpulse", version: "0.1.0" },
});

async function guarded(req: Request): Promise<Response> {
  const { cronSecret } = await resolveSettings();
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return handler(req);
}

export { guarded as GET, guarded as POST };
