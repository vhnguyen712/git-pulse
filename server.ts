/**
 * Custom server: wraps Next.js in a plain http.Server so we can also route
 * WebSocket upgrades to the embedded-terminal handler (lib/terminal/server.ts).
 * Next's own HMR/dev upgrade traffic is handed to `app.getUpgradeHandler()`
 * unchanged, so this is additive — everything Next normally does still works.
 *
 * Replaces `next dev` / `next start` as the process entry point (see the
 * "dev"/"start" scripts in package.json), which is the standard way to add
 * a second upgrade path alongside Next's own.
 */
import { createServer } from "node:http";
import { URL } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";
import { attachTerminal, isSameOrigin } from "@/lib/terminal/server";
import { startAutoSyncScheduler } from "@/lib/auto-sync-scheduler";

const dev = process.env.NODE_ENV !== "production";
const hostname = "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function main() {
  await app.prepare();
  // Unlike getRequestHandler(), getUpgradeHandler() resolves eagerly against
  // the running server instance — it throws "prepare() must be called
  // before performing this operation" if requested beforehand.
  const upgrade = app.getUpgradeHandler();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("Error handling request:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", `http://${hostname}:${port}`);

    if (pathname === "/api/terminal") {
      // Reject before the WebSocket handshake completes — a browser can't
      // spoof the Origin header, so this is a real boundary, not cosmetic.
      if (!isSameOrigin(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachTerminal(ws, req).catch((err) => {
          console.error("Terminal attach failed:", err);
          ws.close(1011, "Internal error.");
        });
      });
      return;
    }

    // Everything else (Next's HMR websocket, etc.) goes to Next itself.
    upgrade(req, socket, head).catch((err) => {
      console.error("Error handling upgrade:", err);
      socket.destroy();
    });
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });

  // In-app auto-sync: a single long-lived ticker that re-syncs stale pinned
  // projects on the interval configured in Settings (read fresh each tick, so
  // toggling it needs no restart). Only meaningful for a persistent process,
  // so it's skipped in dev where `next dev` re-evaluates modules on change.
  if (!dev) startAutoSyncScheduler();
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
