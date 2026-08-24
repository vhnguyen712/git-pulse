/**
 * stdio entrypoint for local coding agents (e.g. Claude Code):
 *
 *   claude mcp add gitpulse -- npx tsx mcp/stdio.ts
 *
 * Run from the repo root so the SQLite DB under .gitpulse/ resolves to the
 * same file the Next.js dev server uses.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerGitPulseTools } from "@/lib/mcp/register";

async function main() {
  const server = new McpServer({ name: "gitpulse", version: "0.1.0" });
  registerGitPulseTools(server);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("gitpulse MCP stdio server failed:", err);
  process.exit(1);
});
