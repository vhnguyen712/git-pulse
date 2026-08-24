import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

const SETTINGS_ID = "default";

export interface ResolvedSettings {
  githubToken: string | null;
  llmBaseUrl: string | null;
  llmApiKey: string | null;
  llmModel: string | null;
  cronSecret: string | null;
  costPerMillionInput: string | null;
  costPerMillionOutput: string | null;
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
  };

  if ("githubToken" in update) next.githubToken = update.githubToken || null;
  if ("llmBaseUrl" in update) next.llmBaseUrl = update.llmBaseUrl || null;
  if ("llmApiKey" in update) next.llmApiKey = update.llmApiKey || null;
  if ("llmModel" in update) next.llmModel = update.llmModel || null;
  if ("cronSecret" in update) next.cronSecret = update.cronSecret || null;
  if ("costPerMillionInput" in update)
    next.costPerMillionInput = update.costPerMillionInput || null;
  if ("costPerMillionOutput" in update)
    next.costPerMillionOutput = update.costPerMillionOutput || null;

  await db
    .insert(settings)
    .values({ ...next, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { ...next, updatedAt: Date.now() },
    });
}
