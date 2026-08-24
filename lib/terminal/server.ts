import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { db } from "@/lib/db";
import { logger } from "@/lib/logging";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Attaches a WebSocket to a real `claude` process running in a project's
 * local clone, via a pseudoterminal. This is the server half of the
 * embedded-terminal feature — the browser can't spawn a local process, but
 * this Node server (see server.ts) can.
 *
 * Called from the HTTP server's `upgrade` handler once the socket has
 * already been accepted (see server.ts); this function decides whether the
 * connection is allowed to proceed and, if so, wires it to a PTY.
 */
export async function attachTerminal(ws: WebSocket, req: IncomingMessage) {
  // Real rejection happens earlier, in server.ts's `upgrade` handler, before
  // the WebSocket handshake completes — this is defense-in-depth in case
  // attachTerminal is ever wired up from somewhere that skips that check.
  if (!isSameOrigin(req)) {
    ws.close(4003, "Cross-origin connections are not allowed.");
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) {
    ws.close(4000, "Missing projectId.");
    return;
  }

  const project = await db.query.projects.findFirst({
    where: (p, { eq }) => eq(p.id, projectId),
  });
  if (!project) {
    ws.close(4004, "Project not found.");
    return;
  }
  if (!project.localPath || !isDirectory(project.localPath)) {
    ws.close(4004, "This project has no valid local clone path set.");
    return;
  }

  const cols = clampDimension(url.searchParams.get("cols"), DEFAULT_COLS);
  const rows = clampDimension(url.searchParams.get("rows"), DEFAULT_ROWS);
  const prompt = url.searchParams.get("prompt");

  const claudePath = resolveClaudeExecutable();
  if (!claudePath) {
    ws.close(4005, "claude was not found on PATH. Install Claude Code and try again.");
    return;
  }

  let child: pty.IPty;
  try {
    child = pty.spawn(claudePath, [], {
      cwd: project.localPath,
      cols,
      rows,
      name: "xterm-256color",
      env: process.env as Record<string, string>,
    });
  } catch (err) {
    logger.error("Failed to spawn claude for embedded terminal", err);
    ws.close(4005, "Failed to start claude.");
    return;
  }

  // Pre-fill (but don't send) the action item's prompt, mirroring the
  // claude-cli:// deep link: the user reviews it and presses Enter.
  if (prompt) child.write(prompt);

  child.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  child.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) ws.close(1000, `claude exited (${exitCode})`);
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString("utf8");
    const resize = tryParseResize(text);
    if (resize) {
      child.resize(resize.cols, resize.rows);
      return;
    }
    child.write(text);
  });

  ws.on("close", () => {
    try {
      child.kill();
    } catch {
      // Already exited — nothing to clean up.
    }
  });
}

/** Exported so server.ts can reject a cross-origin upgrade before the
 * WebSocket handshake completes, rather than accepting then closing. */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false; // real browsers always send Origin on a WS handshake
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

let cachedClaudePath: string | null | undefined;

/**
 * node-pty's spawn does not do a shell-style PATH search for a bare command
 * name — confirmed by testing: `pty.spawn("claude", ...)` throws "File not
 * found" on Windows even though `claude` resolves fine via `where`/`which`,
 * while the same call with claude's absolute path works. So PATH has to be
 * searched by hand here, same as a shell would (including PATHEXT on
 * Windows, since `claude` there is `claude.exe`).
 */
function resolveClaudeExecutable(): string | null {
  if (cachedClaudePath !== undefined) return cachedClaudePath;

  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `claude${ext}`);
      if (!fs.existsSync(candidate)) continue;
      if (process.platform !== "win32") {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      cachedClaudePath = candidate;
      return candidate;
    }
  }
  cachedClaudePath = null;
  return null;
}

function clampDimension(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 500 ? n : fallback;
}

/** A resize control frame is the one bit of structured protocol on this
 * socket; everything else is raw keystroke data written straight to the pty. */
function tryParseResize(text: string): { cols: number; rows: number } | null {
  if (!text.startsWith("{")) return null;
  try {
    const obj = JSON.parse(text);
    if (
      obj &&
      obj.type === "resize" &&
      Number.isInteger(obj.cols) &&
      Number.isInteger(obj.rows)
    ) {
      return { cols: obj.cols, rows: obj.rows };
    }
  } catch {
    // Not JSON — treat as literal terminal input.
  }
  return null;
}
