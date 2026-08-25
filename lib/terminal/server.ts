import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { db } from "@/lib/db";
import { logger } from "@/lib/logging";
import { createSessionWorktree, isGitRepo, removeSessionWorktree } from "@/lib/terminal/worktree";
import { effectiveAgentCommand, getAgent } from "@/lib/terminal/agents";
import { trustAntigravityWorkspace } from "@/lib/terminal/antigravity";
import { resolveSettings } from "@/lib/settings";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// How long a pty is kept alive after its WebSocket disconnects before it's
// killed for good. Covers a refreshed tab, a laptop sleeping, or a flaky
// network — the browser's reconnect (same sessionId) picks the same pty
// back up mid-scrollback instead of starting the agent CLI over.
const RECONNECT_GRACE_MS = 5 * 60 * 1000;

// Scrollback kept per session so a reconnecting client (fresh xterm
// instance, e.g. after a page reload) can be replayed up to date. Capped so
// a long-running session doesn't grow this without bound.
const MAX_BUFFER_CHARS = 200_000;

interface TerminalSession {
  id: string;
  child: pty.IPty;
  projectId: string;
  /** Human label of the agent CLI running in this session (e.g. "Claude Code"), for close/error messages. */
  agentLabel: string;
  buffer: string;
  ws: WebSocket | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  /** The main clone this session's worktree belongs to (null when not running
   * in a dedicated worktree — e.g. the localPath isn't a git repo). */
  repoPath: string | null;
  /** Dedicated git worktree this session's agent CLI runs in, removed when the
   * pty exits for good. Null when running directly in the repo (see above). */
  worktreePath: string | null;
}

// Keyed by the client-generated sessionId (see components/terminal-panel.tsx),
// not by socket — that's what lets a new socket reattach to an existing pty.
const sessions = new Map<string, TerminalSession>();

/**
 * Normalized, lower-cased paths of worktrees backing a currently-live session,
 * so the worktree-cleanup API (app/api/worktrees) can refuse to remove one
 * that's still in use — its agent CLI is mid-task and would lose its directory
 * out from under it. Runs in the same process as the API routes (see
 * server.ts), so this in-memory view is authoritative.
 */
export function activeWorktreePaths(): Set<string> {
  const paths = new Set<string>();
  for (const s of sessions.values()) {
    if (s.worktreePath) paths.add(path.normalize(s.worktreePath).toLowerCase());
  }
  return paths;
}

/**
 * Attaches a WebSocket to a real agent-CLI process (Claude Code, Codex,
 * Antigravity, ... — see lib/terminal/agents.ts) running in a project's
 * local clone, via a pseudoterminal. This is the server half of the
 * embedded-terminal feature — the browser can't spawn a local process, but
 * this Node server (see server.ts) can.
 *
 * Called from the HTTP server's `upgrade` handler once the socket has
 * already been accepted (see server.ts); this function decides whether the
 * connection is allowed to proceed and, if so, wires it to a PTY — either a
 * brand new one, or an existing one identified by `sessionId` that survived
 * a prior disconnect (see RECONNECT_GRACE_MS).
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

  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    ws.close(4000, "Missing sessionId.");
    return;
  }

  const cols = clampDimension(url.searchParams.get("cols"), DEFAULT_COLS);
  const rows = clampDimension(url.searchParams.get("rows"), DEFAULT_ROWS);

  const existing = sessions.get(sessionId);
  if (existing) {
    if (existing.projectId !== projectId) {
      ws.close(4003, "Session does not belong to this project.");
      return;
    }
    reattachSession(existing, ws, { cols, rows, replay: url.searchParams.get("replay") !== "false" });
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

  const prompt = url.searchParams.get("prompt");

  const agent = getAgent(url.searchParams.get("agent"));
  const settings = await resolveSettings();
  const { command, args } = effectiveAgentCommand(agent, settings.agentOverrides[agent.id]);

  const exePath = resolveExecutable(command);
  if (!exePath) {
    ws.close(4005, `${agent.label} (\`${command}\`) was not found on PATH. Install it and try again.`);
    return;
  }

  // Give each session its own git worktree so concurrent terminals don't share
  // (and clobber) one working tree. Falls back to the repo itself when it isn't
  // a git repo or the worktree can't be created — behavior is unchanged there.
  let cwd = project.localPath;
  let repoPath: string | null = null;
  let worktreePath: string | null = null;
  if (await isGitRepo(project.localPath)) {
    repoPath = project.localPath;
    worktreePath = await createSessionWorktree(
      project.localPath,
      sessionId,
      project.syncBranch ?? project.defaultBranch,
    );
    if (worktreePath) cwd = worktreePath;
    else repoPath = null; // creation failed; nothing to clean up later
  }

  // Antigravity treats every new directory as untrusted on first launch; pre-trust
  // this session's (fresh, one-off) worktree so that dialog doesn't eat the seeded
  // prompt written below. See lib/terminal/antigravity.ts for why this is needed.
  if (agent.id === "antigravity") trustAntigravityWorkspace(cwd);

  let child: pty.IPty;
  try {
    child = pty.spawn(exePath, args, {
      cwd,
      cols,
      rows,
      name: "xterm-256color",
      env: process.env as Record<string, string>,
    });
  } catch (err) {
    logger.error(`Failed to spawn ${agent.id} for embedded terminal`, err);
    if (repoPath && worktreePath) {
      void removeSessionWorktree(repoPath, worktreePath);
    }
    ws.close(4005, `Failed to start ${agent.label}.`);
    return;
  }

  const session: TerminalSession = {
    id: sessionId,
    child,
    projectId,
    agentLabel: agent.label,
    buffer: "",
    ws,
    disconnectTimer: null,
    repoPath,
    worktreePath,
  };
  sessions.set(sessionId, session);

  // Pre-fill (but don't send) the action item's prompt, mirroring the
  // claude-cli:// deep link: the user reviews it and presses Enter.
  //
  // Some TUIs (agy) enable bracketed-paste mode and treat a raw newline as
  // "submit"; wrap the multi-line prompt so its newlines are inserted as
  // literal content into the input box instead of firing off each line.
  const seededPrompt =
    prompt && agent.wrapPromptInBracketedPaste ? `\x1b[200~${prompt}\x1b[201~` : prompt;

  let promptWritten = !prompt;
  const flushPrompt = () => {
    if (promptWritten) return;
    promptWritten = true;
    child.write(seededPrompt!);
  };

  // Most CLIs read input immediately, so the prompt can be written right on
  // spawn — it just waits in the pty until they read it. But an agent with a
  // promptReadySignal does async startup work first (e.g. agy's sign-in) and
  // drops anything written before it's listening, so its prompt is held back
  // until that marker appears in the output, then a short settle for the ready
  // screen to finish drawing. Tracked here and driven from child.onData below.
  const readySignal = prompt ? agent.promptReadySignal : undefined;
  let readyBuffer = "";
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let readySeen = false;
  const settleThenFlush = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(flushPrompt, 250);
  };
  const watchForReady = (data: string) => {
    if (promptWritten || !readySignal) return;
    if (!readySeen) {
      // Only scan a bounded tail — the marker is short and the ready screen
      // arrives well within this — so a long-running session can't grow this.
      readyBuffer = (readyBuffer + data).slice(-8192);
      if (readyBuffer.includes(readySignal)) readySeen = true;
    }
    if (readySeen) settleThenFlush();
  };

  if (prompt && !readySignal) {
    flushPrompt();
  } else if (readySignal) {
    setTimeout(flushPrompt, 20_000); // safety net if the marker never appears
  }

  child.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_CHARS);
    }
    if (session.ws && session.ws.readyState === session.ws.OPEN) session.ws.send(data);
    watchForReady(data);
  });
  child.onExit(({ exitCode }) => {
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    sessions.delete(session.id);
    // Single teardown point for the session's worktree: every path that ends a
    // session (natural exit, user kill, reconnect-grace expiry) kills the pty,
    // which lands here. A non-force remove keeps any uncommitted work on disk.
    if (session.repoPath && session.worktreePath) {
      void removeSessionWorktree(session.repoPath, session.worktreePath);
    }
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      session.ws.close(1000, `${session.agentLabel} exited (${exitCode})`);
    }
  });

  wireSocket(session, ws);
}

/** Rewires a fresh WebSocket to a pty that's still alive from a previous
 * connection — cancels the pending grace-period kill, closes out the old
 * socket if one is somehow still open (e.g. two tabs racing), resizes to
 * match the reconnecting client, and optionally replays buffered output. */
function reattachSession(
  session: TerminalSession,
  ws: WebSocket,
  opts: { cols: number; rows: number; replay: boolean },
) {
  if (session.disconnectTimer) {
    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
  }
  if (session.ws && session.ws !== ws && session.ws.readyState === session.ws.OPEN) {
    session.ws.close(4009, "Reconnected from another tab.");
  }
  session.ws = ws;
  try {
    session.child.resize(opts.cols, opts.rows);
  } catch {
    // Pty may have just exited; child.onExit will handle tearing things down.
  }
  if (opts.replay && session.buffer) ws.send(session.buffer);
  wireSocket(session, ws);
}

function wireSocket(session: TerminalSession, ws: WebSocket) {
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString("utf8");
    const control = tryParseControl(text);
    if (control?.type === "resize") {
      session.child.resize(control.cols, control.rows);
      return;
    }
    if (control?.type === "kill") {
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
      sessions.delete(session.id);
      try {
        session.child.kill();
      } catch {
        // Already exited — nothing to clean up.
      }
      ws.close(4001, "Session closed by user.");
      return;
    }
    session.child.write(text);
  });

  ws.on("close", () => {
    // A stale listener from a socket this session already moved on from
    // (reattachSession rewires `on("message"/"close")` onto the new socket,
    // but the old socket's own listeners — this one — still fire when it
    // closes). Only the current socket's close should start the grace timer.
    if (session.ws !== ws) return;
    session.ws = null;
    session.disconnectTimer = setTimeout(() => {
      sessions.delete(session.id);
      try {
        session.child.kill();
      } catch {
        // Already exited — nothing to clean up.
      }
    }, RECONNECT_GRACE_MS);
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

const executableCache = new Map<string, string | null>();

/**
 * node-pty's spawn does not do a shell-style PATH search for a bare command
 * name — confirmed by testing: `pty.spawn("claude", ...)` throws "File not
 * found" on Windows even though `claude` resolves fine via `where`/`which`,
 * while the same call with claude's absolute path works. So PATH has to be
 * searched by hand here, same as a shell would (including PATHEXT on
 * Windows, since `claude` there is `claude.exe`).
 *
 * `command` may itself already be an absolute path (e.g. a Settings
 * override pointing at a non-standard install) — in that case it's used
 * directly rather than searched for on PATH.
 */
function resolveExecutable(command: string): string | null {
  if (executableCache.has(command)) return executableCache.get(command)!;

  if (path.isAbsolute(command)) {
    const found = isExecutableFile(command) ? command : null;
    executableCache.set(command, found);
    return found;
  }

  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (isExecutableFile(candidate)) {
        executableCache.set(command, candidate);
        return candidate;
      }
    }
  }
  executableCache.set(command, null);
  return null;
}

function isExecutableFile(candidate: string): boolean {
  if (!fs.existsSync(candidate)) return false;
  if (process.platform !== "win32") {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      return false;
    }
  }
  return true;
}

function clampDimension(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 500 ? n : fallback;
}

/** The one bit of structured protocol on this socket (resize on connect,
 * plus an explicit kill for a user-initiated close); everything else is raw
 * keystroke data written straight to the pty. */
function tryParseControl(
  text: string,
): { type: "resize"; cols: number; rows: number } | { type: "kill" } | null {
  if (!text.startsWith("{")) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && obj.type === "resize" && Number.isInteger(obj.cols) && Number.isInteger(obj.rows)) {
      return { type: "resize", cols: obj.cols, rows: obj.rows };
    }
    if (obj && obj.type === "kill") {
      return { type: "kill" };
    }
  } catch {
    // Not JSON — treat as literal terminal input.
  }
  return null;
}
