import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import type { AgentOverrides } from "@/lib/terminal/agents";

const SETTINGS_ID = "default";

export interface ResolvedSettings {
  githubToken: string | null;
  llmBaseUrl: string | null;
  llmApiKey: string | null;
  llmModel: string | null;
  cronSecret: string | null;
  costPerMillionInput: string | null;
  costPerMillionOutput: string | null;
  /** In-app auto-sync scheduler (server.ts). Not env-backed — UI-only config. */
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number | null;
  agentOverrides: AgentOverrides;
  /** Run cockpit: auto-run programmatic verification after an instrumented run. */
  runAutoVerify: boolean;
  /** Verification commands (parsed); empty falls back to detected package.json scripts. */
  verifyCommands: string[];
}

/** Parses the stored `verify_commands` JSON array, tolerating missing/malformed data. */
export function parseVerifyCommands(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/** Parses the stored `agent_overrides` JSON, tolerating missing/malformed data. */
export function parseAgentOverrides(raw: string | null | undefined): AgentOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as AgentOverrides) : {};
  } catch {
    return {};
  }
}

/**
 * Settings-page values stored in the local SQLite DB take priority; env vars
 * (.env.local) are the fallback, so headless/Docker setups can still
 * configure everything without touching the UI.
 */
export async function resolveSettings(): Promise<ResolvedSettings> {
  const row = await db.query.settings.findFirst({
    where: (s, { eq }) => eq(s.id, SETTINGS_ID),
  });

  return {
    githubToken: row?.githubToken || process.env.GITHUB_TOKEN || null,
    llmBaseUrl: row?.llmBaseUrl || process.env.LLM_BASE_URL || null,
    llmApiKey: row?.llmApiKey || process.env.LLM_API_KEY || null,
    llmModel: row?.llmModel || process.env.LLM_MODEL || null,
    cronSecret: row?.cronSecret || process.env.CRON_SECRET || null,
    costPerMillionInput: row?.costPerMillionInput || process.env.LLM_COST_PER_MILLION_INPUT || null,
    costPerMillionOutput: row?.costPerMillionOutput || process.env.LLM_COST_PER_MILLION_OUTPUT || null,
    autoSyncEnabled: Boolean(row?.autoSyncEnabled),
    autoSyncIntervalMinutes: row?.autoSyncIntervalMinutes ?? null,
    agentOverrides: parseAgentOverrides(row?.agentOverrides),
    runAutoVerify: Boolean(row?.runAutoVerify),
    verifyCommands: parseVerifyCommands(row?.verifyCommands),
  };
}

export interface SettingsSource {
  githubToken: "settings" | "env" | "none";
  llmBaseUrl: "settings" | "env" | "none";
  llmApiKey: "settings" | "env" | "none";
  llmModel: "settings" | "env" | "none";
  cronSecret: "settings" | "env" | "none";
  costPerMillionInput: "settings" | "env" | "none";
  costPerMillionOutput: "settings" | "env" | "none";
}

function sourceOf(dbValue: string | null | undefined, envValue: string | undefined) {
  if (dbValue) return "settings" as const;
  if (envValue) return "env" as const;
  return "none" as const;
}

/** Raw DB row (no env fallback) plus where each effective value actually came from — used to render the Settings form. */
export async function getSettingsForDisplay() {
  const row = await db.query.settings.findFirst({
    where: (s, { eq }) => eq(s.id, SETTINGS_ID),
  });

  const source: SettingsSource = {
    githubToken: sourceOf(row?.githubToken, process.env.GITHUB_TOKEN),
    llmBaseUrl: sourceOf(row?.llmBaseUrl, process.env.LLM_BASE_URL),
    llmApiKey: sourceOf(row?.llmApiKey, process.env.LLM_API_KEY),
    llmModel: sourceOf(row?.llmModel, process.env.LLM_MODEL),
    cronSecret: sourceOf(row?.cronSecret, process.env.CRON_SECRET),
    costPerMillionInput: sourceOf(
      row?.costPerMillionInput,
      process.env.LLM_COST_PER_MILLION_INPUT,
    ),
    costPerMillionOutput: sourceOf(
      row?.costPerMillionOutput,
      process.env.LLM_COST_PER_MILLION_OUTPUT,
    ),
  };

  return { row: row ?? null, source };
}

/** "ghp_xxxx…ab12" → "••••ab12" — never send a full stored secret back to the browser. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const tail = value.slice(-4);
  return `••••${tail}`;
}

export interface SettingsUpdate {
  githubToken?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  cronSecret?: string;
  costPerMillionInput?: string;
  costPerMillionOutput?: string;
  autoSyncEnabled?: boolean;
  /** Null clears the stored interval (falls back to the built-in default). */
  autoSyncIntervalMinutes?: number | null;
  /** Replaces the whole overrides map (the settings form submits it in full, not per-agent). */
  agentOverrides?: AgentOverrides;
  runAutoVerify?: boolean;
  /** Replaces the verification command list; empty clears it (falls back to detected scripts). */
  verifyCommands?: string[];
}

/**
 * Upserts only the fields present in `update`. An empty string clears that
 * field (falls back to env var again); a field simply absent from the
 * payload is left untouched — lets the form submit only changed fields.
 */
export async function upsertSettings(update: SettingsUpdate): Promise<void> {
  const existing = await db.query.settings.findFirst({
    where: (s, { eq }) => eq(s.id, SETTINGS_ID),
  });

  const next = {
    id: SETTINGS_ID,
    githubToken: existing?.githubToken ?? null,
    llmBaseUrl: existing?.llmBaseUrl ?? null,
    llmApiKey: existing?.llmApiKey ?? null,
    llmModel: existing?.llmModel ?? null,
    cronSecret: existing?.cronSecret ?? null,
    costPerMillionInput: existing?.costPerMillionInput ?? null,
    costPerMillionOutput: existing?.costPerMillionOutput ?? null,
    autoSyncEnabled: existing?.autoSyncEnabled ?? null,
    autoSyncIntervalMinutes: existing?.autoSyncIntervalMinutes ?? null,
    agentOverrides: existing?.agentOverrides ?? null,
    runAutoVerify: existing?.runAutoVerify ?? null,
    verifyCommands: existing?.verifyCommands ?? null,
  };

  if ("githubToken" in update) next.githubToken = update.githubToken || null;
  if ("llmBaseUrl" in update) next.llmBaseUrl = update.llmBaseUrl || null;
  if ("llmApiKey" in update) next.llmApiKey = update.llmApiKey || null;
  if ("llmModel" in update) next.llmModel = update.llmModel || null;
  if ("cronSecret" in update) next.cronSecret = update.cronSecret || null;
  if ("agentOverrides" in update) {
    const cleaned = update.agentOverrides
      ? Object.fromEntries(
          Object.entries(update.agentOverrides).filter(
            ([, v]) => v && (v.command?.trim() || (v.args && v.args.length > 0)),
          ),
        )
      : {};
    next.agentOverrides = Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null;
  }
  if ("costPerMillionInput" in update)
    next.costPerMillionInput = update.costPerMillionInput || null;
  if ("costPerMillionOutput" in update)
    next.costPerMillionOutput = update.costPerMillionOutput || null;
  if ("autoSyncEnabled" in update) next.autoSyncEnabled = update.autoSyncEnabled ?? null;
  if ("autoSyncIntervalMinutes" in update)
    next.autoSyncIntervalMinutes = update.autoSyncIntervalMinutes ?? null;
  if ("runAutoVerify" in update) next.runAutoVerify = update.runAutoVerify ?? null;
  if ("verifyCommands" in update) {
    const cleaned = (update.verifyCommands ?? []).map((c) => c.trim()).filter(Boolean);
    next.verifyCommands = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
  }

  await db
    .insert(settings)
    .values({ ...next, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { ...next, updatedAt: Date.now() },
    });
}
