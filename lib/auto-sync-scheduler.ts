import { resolveSettings } from "@/lib/settings";
import { runAutoSync, resolveIntervalMinutes } from "@/lib/auto-sync";
import { logger } from "@/lib/logging";

/** How often the ticker wakes to check whether a sweep is due. */
const TICK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
/** True while a sweep is in flight — skips overlapping ticks (a slow sweep must not stack). */
let running = false;
/** Epoch ms of the last sweep that actually ran, so the interval is measured run-to-run. */
let lastRunAt = 0;

async function tick() {
  if (running) return;

  let settings;
  try {
    settings = await resolveSettings();
  } catch (err) {
    // Config/DB read failing must never crash the ticker — try again next tick.
    logger.error("Auto-sync scheduler: failed to read settings", err);
    return;
  }

  if (!settings.autoSyncEnabled) return;

  const intervalMs = resolveIntervalMinutes(settings.autoSyncIntervalMinutes) * 60_000;
  if (Date.now() - lastRunAt < intervalMs) return;

  running = true;
  lastRunAt = Date.now();
  try {
    const result = await runAutoSync();
    if (result.ranCount > 0) {
      logger.info(
        `Auto-sync swept ${result.ranCount}/${result.staleCount} stale project(s)`,
      );
    }
  } catch (err) {
    // GitHub/LLM config or rate-limit errors surface here — log and move on so
    // the next tick retries once the interval elapses again.
    logger.error("Auto-sync sweep failed", err);
  } finally {
    running = false;
  }
}

/**
 * Starts the in-app auto-sync ticker. Idempotent — a second call is a no-op so
 * a hot-reload can't spawn a second timer. Called from server.ts once the HTTP
 * server is listening. The ticker itself is cheap: it only reads settings and
 * bails unless auto-sync is enabled and the configured interval has elapsed.
 */
export function startAutoSyncScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // Don't keep the process alive solely for this ticker.
  if (typeof timer.unref === "function") timer.unref();
}

/** Stops the ticker (used by tests; the real process runs until shutdown). */
export function stopAutoSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
