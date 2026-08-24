import { NextResponse } from "next/server";
import { z } from "zod";
import {
  testGithubToken,
  GitHubRateLimitError,
} from "@/lib/github";
import { resolveSettings } from "@/lib/settings";
import { logger } from "@/lib/logging";

const bodySchema = z.object({
  /** Test this value directly if provided — lets the Settings page check an
   *  unsaved, freshly-pasted token. Falls back to the saved/env token when
   *  omitted or blank. */
  token: z.string().optional(),
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

  let token = parsed.data.token?.trim();
  if (!token) {
    token = (await resolveSettings()).githubToken ?? undefined;
  }
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No token to test — paste one above or save one first." },
      { status: 200 },
    );
  }

  try {
    const { login } = await testGithubToken(token);
    return NextResponse.json({ ok: true, login });
  } catch (err) {
    if (err instanceof GitHubRateLimitError) {
      return NextResponse.json({
        ok: false,
        error: `Rate limited by GitHub, but the token is valid. Resets at ${new Date(
          err.resetAt * 1000,
        ).toLocaleTimeString()}.`,
      });
    }
    const status = (err as { status?: number } | null)?.status;
    if (status === 401) {
      return NextResponse.json({ ok: false, error: "Invalid token (401 Bad credentials)." });
    }
    logger.error("POST /api/settings/test-github failed", err);
    return NextResponse.json({ ok: false, error: "Connection failed." });
  }
}
