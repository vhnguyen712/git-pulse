import { NextResponse } from "next/server";
import {
  getSettingsForDisplay,
  upsertSettings,
  maskSecret,
} from "@/lib/settings";
import { settingsUpdateSchema } from "@/lib/schema";
import { logger } from "@/lib/logging";

export interface SettingsResponse {
  githubTokenSet: boolean;
  githubTokenMasked: string | null;
  githubTokenSource: "settings" | "env" | "none";
  llmBaseUrl: string | null;
  llmBaseUrlSource: "settings" | "env" | "none";
  llmApiKeySet: boolean;
  llmApiKeyMasked: string | null;
  llmApiKeySource: "settings" | "env" | "none";
  llmModel: string | null;
  llmModelSource: "settings" | "env" | "none";
  cronSecretSet: boolean;
  cronSecretMasked: string | null;
  cronSecretSource: "settings" | "env" | "none";
  costPerMillionInput: string | null;
  costPerMillionInputSource: "settings" | "env" | "none";
  costPerMillionOutput: string | null;
  costPerMillionOutputSource: "settings" | "env" | "none";
}

async function buildResponse(): Promise<SettingsResponse> {
  const { row, source } = await getSettingsForDisplay();
  return {
    githubTokenSet: Boolean(row?.githubToken),
    githubTokenMasked: maskSecret(row?.githubToken),
    githubTokenSource: source.githubToken,
    llmBaseUrl: row?.llmBaseUrl ?? null,
    llmBaseUrlSource: source.llmBaseUrl,
    llmApiKeySet: Boolean(row?.llmApiKey),
    llmApiKeyMasked: maskSecret(row?.llmApiKey),
    llmApiKeySource: source.llmApiKey,
    llmModel: row?.llmModel ?? null,
    llmModelSource: source.llmModel,
    cronSecretSet: Boolean(row?.cronSecret),
    cronSecretMasked: maskSecret(row?.cronSecret),
    cronSecretSource: source.cronSecret,
    costPerMillionInput: row?.costPerMillionInput ?? null,
    costPerMillionInputSource: source.costPerMillionInput,
    costPerMillionOutput: row?.costPerMillionOutput ?? null,
    costPerMillionOutputSource: source.costPerMillionOutput,
  };
}

export async function GET() {
  try {
    return NextResponse.json(await buildResponse());
  } catch (err) {
    logger.error("GET /api/settings failed", err);
    return NextResponse.json({ error: "Failed to load settings." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = settingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings payload." }, { status: 400 });
  }

  try {
    await upsertSettings(parsed.data);
    return NextResponse.json(await buildResponse());
  } catch (err) {
    logger.error("POST /api/settings failed", err);
    return NextResponse.json({ error: "Failed to save settings." }, { status: 500 });
  }
}
