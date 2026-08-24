"use client";

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Loader2, SquareTerminal, X } from "lucide-react";
import type { Project } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

type Status = "no-path" | "connecting" | "connected" | "closed" | "error";

/**
 * Embedded terminal panel: runs a real `claude` session (via lib/terminal/server.ts
 * + server.ts's WebSocket upgrade) in the project's local clone, seeded with an
 * action item's prompt. The browser can't spawn a process itself — this pipes
 * xterm.js to a PTY the server owns.
 */
export function TerminalPanel({
  project,
  prompt,
  onClose,
  onProjectUpdate,
}: {
  project: Project;
  /** Task text to pre-fill in claude's input once the session connects. */
  prompt: string;
  onClose: () => void;
  onProjectUpdate: (project: Project) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>(project.localPath ? "connecting" : "no-path");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [savingPath, setSavingPath] = useState(false);

  // Separate "should a connection attempt happen" from `status`: the effect
  // below sets `status` as the connection progresses (connecting → connected
  // → closed), and if the effect depended on `status` itself, each of those
  // updates would re-trigger it — tearing the just-opened terminal back down
  // immediately. `shouldConnect` only flips false→true once (on mount, or
  // when the local path is saved), so the effect runs exactly once per
  // session instead of once per status transition.
  const [shouldConnect, setShouldConnect] = useState(Boolean(project.localPath));

  useEffect(() => {
    if (!shouldConnect || !containerRef.current || !project.localPath) return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let resizeObserver: ResizeObserver | null = null;

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
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams({
        projectId: project.id,
        prompt,
        cols: String(term.cols),
        rows: String(term.rows),
      });
      ws = new WebSocket(`${proto}//${window.location.host}/api/terminal?${params}`);

      ws.onopen = () => !disposed && setStatus("connected");
      ws.onmessage = (ev) => term?.write(String(ev.data));
      ws.onclose = (ev) => {
        if (disposed) return;
        setStatus("closed");
        if (ev.code !== 1000) setErrorMessage(ev.reason || "Connection closed.");
      };
      ws.onerror = () => !disposed && setErrorMessage("WebSocket error.");

      term.onData((data) => ws?.readyState === WebSocket.OPEN && ws.send(data));
      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      resizeObserver = new ResizeObserver(() => fitAddon.fit());
      resizeObserver.observe(containerRef.current);
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      ws?.close();
      term?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when shouldConnect flips true; project/prompt are stable for the panel's lifetime (see the comment on shouldConnect above).
  }, [shouldConnect]);

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
    <div className="flex h-80 flex-col border-t border-outline-variant bg-surface-container-lowest">
      <div className="flex shrink-0 items-center justify-between border-b border-outline-variant px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-xs text-on-surface-variant">
          <SquareTerminal className="size-3.5" />
          claude — {project.owner}/{project.repoName}
          {status === "connecting" && <Loader2 className="size-3 animate-spin" />}
        </div>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-on-surface-variant hover:bg-white/10 hover:text-on-surface"
          title="Close terminal"
        >
          <X className="size-3.5" />
        </button>
      </div>

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
        <div className="relative flex-1 overflow-hidden p-2">
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
