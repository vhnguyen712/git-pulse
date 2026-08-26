"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Loader2, SquareTerminal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTerminal, type TerminalSession as Session } from "@/components/terminal-context";
import { getAgent } from "@/lib/terminal/agents";
import type { Project } from "@/lib/db/schema";

type Status = "no-path" | "connecting" | "connected" | "reconnecting" | "closed" | "error";

// Codes the server closes with that mean "this session is really over" —
// the pty exited or the user explicitly killed it — as opposed to a dropped
// connection the client should try to recover (network hiccup, laptop
// sleep, dev server restart). See lib/terminal/server.ts.
const TERMINAL_CLOSE_CODES = new Set([1000, 4000, 4001, 4003, 4004, 4005]);
const MAX_RECONNECT_ATTEMPTS = 6;

function sessionStorageKey(id: string) {
  return `terminal-session:${id}`;
}

/**
 * Embedded terminal footer: runs real `claude` sessions (via lib/terminal/server.ts
 * + server.ts's WebSocket upgrade) in a project's local clone, seeded with an
 * action item's prompt. The browser can't spawn a process itself — this pipes
 * xterm.js to a PTY the server owns.
 *
 * Multiple tasks can be open at once, one tab each; every session stays mounted
 * (inactive ones just hidden) so switching tabs doesn't tear down its pty or
 * lose its scrollback. Rendered once at the app-shell level (not per-page) so
 * navigating between pages doesn't drop the connections either.
 */
export function TerminalDock() {
  const { sessions, activeId, height, activateSession, closeSession, updateProject, setHeight } =
    useTerminal();

  // Per-tab connection status, reported up by each session, so the tab strip
  // can show a spinner while a session is (re)connecting.
  const [statuses, setStatuses] = useState<Record<string, Status>>({});

  // Each pane registers a "kill this pty" fn here so closing its tab can tell
  // the server to actually terminate `claude`, rather than dropping the socket
  // and leaving the process alive for the whole reconnect grace period.
  const killFns = useRef<Map<string, () => void>>(new Map());
  const registerKill = useCallback((id: string, fn: () => void) => {
    killFns.current.set(id, fn);
  }, []);
  const handleClose = useCallback(
    (id: string) => {
      killFns.current.get(id)?.();
      killFns.current.delete(id);
      closeSession(id);
    },
    [closeSession],
  );

  const draggingRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const { startY, startHeight } = draggingRef.current;
      setHeight(startHeight + (startY - e.clientY));
    }
    function onUp() {
      draggingRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setHeight]);

  if (sessions.length === 0) return null;

  return (
    <div
      className="flex shrink-0 flex-col border-t border-outline-variant bg-surface-container-lowest"
      style={{ height }}
    >
      <div
        onMouseDown={(e) => {
          draggingRef.current = { startY: e.clientY, startHeight: height };
        }}
        className="h-1.5 shrink-0 cursor-row-resize bg-transparent hover:bg-primary/40 active:bg-primary/60"
        title="Drag to resize"
      />

      {/* Tab strip */}
      <div className="flex shrink-0 items-stretch gap-px overflow-x-auto border-b border-outline-variant bg-surface-container-low">
        {sessions.map((s) => {
          const isActive = s.id === activeId;
          const status = statuses[s.id];
          return (
            <div
              key={s.id}
              className={cn(
                "group flex min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 border-r border-outline-variant px-3 py-1.5 text-xs",
                isActive
                  ? "bg-surface-container-lowest text-on-surface"
                  : "text-on-surface-variant hover:bg-white/5",
              )}
            >
              <button
                onClick={() => activateSession(s.id)}
                title={`${s.project.owner}/${s.project.repoName} — ${s.title} (${getAgent(s.agentId).label})`}
                className="flex min-w-0 items-center gap-1.5"
              >
                {status === "connecting" || status === "reconnecting" ? (
                  <Loader2 className="size-3 shrink-0 animate-spin" />
                ) : (
                  <SquareTerminal className="size-3 shrink-0" />
                )}
                <span className="truncate">{s.title}</span>
              </button>
              <button
                onClick={() => handleClose(s.id)}
                title="Close tab"
                className="shrink-0 rounded p-0.5 text-on-surface-variant opacity-60 hover:bg-white/10 hover:text-on-surface group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>

      {/* One pane per session; inactive panes stay mounted but hidden. */}
      <div className="relative min-h-0 flex-1">
        {sessions.map((s) => (
          <TerminalPane
            key={s.id}
            session={s}
            active={s.id === activeId}
            onProjectUpdate={updateProject}
            onStatus={(status) => setStatuses((prev) => ({ ...prev, [s.id]: status }))}
            registerKill={registerKill}
          />
        ))}
      </div>
    </div>
  );
}

function TerminalPane({
  session,
  active,
  onProjectUpdate,
  onStatus,
  registerKill,
}: {
  session: Session;
  active: boolean;
  onProjectUpdate: (project: Project) => void;
  onStatus: (status: Status) => void;
  registerKill: (id: string, fn: () => void) => void;
}) {
  const project = session.project;
  const prompt = session.prompt;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [status, setStatus] = useState<Status>(project.localPath ? "connecting" : "no-path");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [savingPath, setSavingPath] = useState(false);

  // Bubble status changes up so the tab strip can reflect them.
  useEffect(() => {
    onStatus(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onStatus identity churns every render; we only care about status transitions.
  }, [status]);

  // Separate "should a connection attempt happen" from `status`: the effect
  // below sets `status` as the connection progresses (connecting → connected
  // → closed), and if the effect depended on `status` itself, each of those
  // updates would re-trigger it — tearing the just-opened terminal back down
  // immediately. `shouldConnect` only flips false→true once (on mount, or
  // when the local path is saved), so the effect runs exactly once per
  // session instead of once per status transition.
  const [shouldConnect, setShouldConnect] = useState(Boolean(project.localPath));

  // Exposed to the close (X) button, which runs outside the effect below —
  // it needs to tell the server "actually kill this" rather than leaving
  // the pty alive for the reconnect grace period.
  const killRef = useRef<() => void>(() => {});
  useEffect(() => {
    registerKill(session.id, () => killRef.current());
  }, [registerKill, session.id]);

  useEffect(() => {
    if (!shouldConnect || !containerRef.current || !project.localPath) return;

    let disposed = false;
    let manuallyKilled = false;
    let ws: WebSocket | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fitAddon: import("@xterm/addon-fit").FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // Stable across the whole panel session (survives reconnects), so a
    // dropped connection reattaches to the same server-side pty instead of
    // starting `claude` over. Keyed by this tab's unique id (not the project)
    // so multiple tabs of the same project don't collide, and persisted in
    // sessionStorage so a same-mount remount recovers the same pty.
    const storageKey = sessionStorageKey(session.id);
    let sessionId = sessionStorage.getItem(storageKey);
    if (!sessionId) {
      sessionId = session.id;
      sessionStorage.setItem(storageKey, sessionId);
    }

    killRef.current = () => {
      manuallyKilled = true;
      sessionStorage.removeItem(storageKey);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "kill" }));
    };

    function connect(isReconnect: boolean) {
      if (disposed || !term || !fitAddon) return;

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams({
        projectId: project.id,
        sessionId: sessionId!,
        agent: session.agentId,
        prompt,
        cols: String(term.cols),
        rows: String(term.rows),
        // Only replay server-side scrollback into a *fresh* xterm instance
        // (first connect of this mount, e.g. after a page reload). A
        // same-mount reconnect (network hiccup) keeps its DOM scrollback,
        // so replaying would just duplicate the tail of it.
        replay: String(!isReconnect),
      });
      if (session.startRef) params.set("startRef", session.startRef);
      ws = new WebSocket(`${proto}//${window.location.host}/api/terminal?${params}`);

      ws.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setStatus("connected");
        setErrorMessage(null);
      };
      ws.onmessage = (ev) => term?.write(String(ev.data));
      ws.onclose = (ev) => {
        if (disposed) return;
        if (manuallyKilled || TERMINAL_CLOSE_CODES.has(ev.code)) {
          setStatus("closed");
          if (ev.code !== 1000 && ev.code !== 4001) {
            setErrorMessage(ev.reason || "Connection closed.");
          }
          if (ev.code === 1000 || manuallyKilled) sessionStorage.removeItem(storageKey);
          return;
        }
        // Unrecognized close code: treat as a dropped connection (network
        // hiccup, server restart) and try to pick the session back up.
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          setStatus("closed");
          setErrorMessage("Lost connection and couldn't reconnect.");
          return;
        }
        attempt += 1;
        setStatus("reconnecting");
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        reconnectTimer = setTimeout(() => connect(true), delay);
      };
      ws.onerror = () => !disposed && setErrorMessage("WebSocket error.");
    }

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !containerRef.current) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        theme: {
          background: "#141313",
          foreground: "#e5e2e1",
          cursor: "#e5e2e1",
          selectionBackground: "#444748",
        },
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      termRef.current = term;
      fitRef.current = fitAddon;
      fitAddon.fit();

      term.onData((data) => ws?.readyState === WebSocket.OPEN && ws.send(data));
      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      resizeObserver = new ResizeObserver(() => fitAddon?.fit());
      resizeObserver.observe(containerRef.current);

      connect(false);
    })();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeObserver?.disconnect();
      ws?.close();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when shouldConnect flips true; session/project/prompt are stable for the tab's lifetime (see the comment on shouldConnect above).
  }, [shouldConnect]);

  // A terminal sized while hidden (display:none) measures 0×0, so refit and
  // refocus whenever this tab becomes the active one.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, status]);

  async function handleSavePath() {
    if (!pathInput.trim()) return;
    setSavingPath(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, localPath: pathInput.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMessage(body.error ?? "Failed to save path.");
        return;
      }
      onProjectUpdate(body.project);
      setStatus("connecting");
      setShouldConnect(true);
    } catch {
      setErrorMessage("Network error.");
    } finally {
      setSavingPath(false);
    }
  }

  return (
    <div className={cn("absolute inset-0 flex min-h-0 flex-col", !active && "hidden")}>
      {status === "no-path" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-xs text-on-surface-variant">
            Set the absolute path to your local clone of {project.owner}/{project.repoName} to
            open a terminal here.
          </p>
          <div className="flex w-full max-w-sm gap-1.5">
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder={"D:\\code\\" + project.repoName}
              className="flex-1 rounded-md border border-outline-variant bg-surface px-2 py-1 text-xs text-on-surface outline-none focus:border-primary"
              onKeyDown={(e) => e.key === "Enter" && handleSavePath()}
            />
            <button
              onClick={handleSavePath}
              disabled={savingPath || !pathInput.trim()}
              className={cn(
                "rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary hover:opacity-90",
                (savingPath || !pathInput.trim()) && "cursor-not-allowed opacity-50",
              )}
            >
              {savingPath ? "Saving…" : "Save & Connect"}
            </button>
          </div>
          {errorMessage && <p className="text-xs text-accent-orange">{errorMessage}</p>}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden p-2">
          <div ref={containerRef} className="h-full w-full" />
          {status === "closed" && errorMessage && (
            <div className="absolute inset-x-2 bottom-2 rounded-md border border-accent-orange/30 bg-accent-orange-bg px-2 py-1 text-xs text-accent-orange">
              {errorMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
