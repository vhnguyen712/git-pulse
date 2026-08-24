import { NextResponse } from "next/server";
import { z } from "zod";
import { testLlmConnection } from "@/lib/llm";
import { resolveSettings } from "@/lib/settings";
import { logger } from "@/lib/logging";

const bodySchema = z.object({
  /** Each field tests the typed value if provided, falling back
   *  independently to the saved/env value when omitted or blank — so
   *  testing a new API key against an already-saved base URL/model works. */
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const saved = await resolveSettings();
  const baseUrl = parsed.data.baseUrl?.trim() || saved.llmBaseUrl || null;
  const apiKey = parsed.data.apiKey?.trim() || saved.llmApiKey || undefined;
  const model = parsed.data.model?.trim() || saved.llmModel || undefined;

  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      error: "No API key to test — paste one above or save one first.",
    });
  }
  if (!model) {
    return NextResponse.json({
      ok: false,
      error: "No model to test — enter one above or save one first.",
    });
  }

  try {
    const { modelFound, modelCount } = await testLlmConnection({ baseUrl, apiKey, model });
    if (!modelFound) {
      return NextResponse.json({
        ok: true,
        warning: true,
        message: `Connected (${modelCount} models listed), but "${model}" wasn't among them — double check the model name.`,
      });
    }
    return NextResponse.json({ ok: true, message: `Connected — "${model}" is available.` });
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 401) {
      return NextResponse.json({ ok: false, error: "Invalid API key (401)." });
    }
    if (status === 404) {
      return NextResponse.json({
        ok: false,
        error: "Endpoint not found (404) — check the Base URL.",
      });
    }
    const message = err instanceof Error ? err.message : "Connection failed.";
    logger.error("POST /api/settings/test-llm failed", err);
    return NextResponse.json({ ok: false, error: message });
  }
}
