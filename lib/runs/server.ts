/**
 * Server half of the run cockpit's WebSocket: the run-timeline counterpart to
 * lib/terminal/server.ts's `attachTerminal`. Where the embedded terminal
 * bridges raw keystrokes to a pty, this bridges a run's recorded step timeline
 * (past + live) and control actions to the cockpit UI — no raw bytes, just
 * structured JSON messages.
 */
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { db } from "@/lib/db";
import { logger } from "@/lib/logging";
import { isSameOrigin } from "@/lib/terminal/server";
import { subscribeRun, type RunEvent } from "@/lib/runs/recorder";
import { applyControl } from "@/lib/runs/runner";
import type { ControlAction } from "@/lib/runs/types";

/** Messages sent from server to client over the run WebSocket. */
export type RunServerMessage =
  | { type: "init"; run: unknown; steps: unknown[] }
  | { type: "step"; step: unknown }
  | { type: "status"; run: unknown }
  | { type: "control_result"; action: ControlAction; ok: boolean; reason?: string };

function send(ws: WebSocket, message: RunServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/**
 * Attaches a WebSocket to a run: replays its persisted timeline, then streams
 * live steps/status changes as they're recorded, and forwards control actions
 * sent by the client to lib/runs/runner.ts's `applyControl`. Called from the
 * HTTP server's `upgrade` handler (see server.ts) once the socket has already
 * been accepted, mirroring lib/terminal/server.ts's `attachTerminal`.
 */
export async function attachRun(ws: WebSocket, req: IncomingMessage): Promise<void> {
  // Defense-in-depth, as with the terminal socket — the real rejection happens
  // in server.ts's `upgrade` handler before the WebSocket handshake completes.
  if (!isSameOrigin(req)) {
    ws.close(4003, "Cross-origin connections are not allowed.");
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const runId = url.searchParams.get("runId");
  if (!runId) {
    ws.close(4000, "Missing runId.");
    return;
  }

  const run = await db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, runId) });
  if (!run) {
    ws.close(4004, "Run not found.");
    return;
  }

  const steps = await db.query.runSteps.findMany({
    where: (s, { eq }) => eq(s.runId, runId),
    orderBy: (s, { asc }) => asc(s.seq),
  });
  send(ws, { type: "init", run, steps });

  const unsubscribe = subscribeRun(runId, (event: RunEvent) => {
    if (event.type === "step") send(ws, { type: "step", step: event.step });
    else send(ws, { type: "status", run: event.run });
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let parsed: { action?: ControlAction; payload?: { text?: string } };
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (!parsed.action) return;
    const action = parsed.action;
    applyControl(runId, action, parsed.payload)
      .then((result) => send(ws, { type: "control_result", action, ok: result.ok, reason: result.reason }))
      .catch((err) => {
        logger.error(`Run ${runId}: control action "${action}" failed`, err);
        send(ws, { type: "control_result", action, ok: false, reason: "Internal error." });
      });
  });

  ws.on("close", () => {
    unsubscribe();
  });
}
