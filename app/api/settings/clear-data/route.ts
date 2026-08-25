import { NextResponse } from "next/server";
import { clearDataRequestSchema } from "@/lib/schema";
import { clearAppData } from "@/lib/data-management";
import { logger } from "@/lib/logging";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = clearDataRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  try {
    await clearAppData(parsed.data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("POST /api/settings/clear-data failed", err);
    return NextResponse.json({ error: "Failed to clear data." }, { status: 500 });
  }
}
