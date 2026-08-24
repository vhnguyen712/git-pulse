import fs from "node:fs";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { updateProjectLocalPathSchema } from "@/lib/schema";
import { logger } from "@/lib/logging";

/**
 * Sets a project's local clone path — the directory the embedded terminal
 * (lib/terminal/server.ts) spawns `claude` in. Validated to actually exist
 * on disk so a stale/typo'd path fails fast here instead of surfacing as a
 * confusing terminal-connect error later.
 */
export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = updateProjectLocalPathSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }
  const { projectId, localPath } = parsed.data;

  let isDir = false;
  try {
    isDir = fs.statSync(localPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return NextResponse.json(
      { error: "That path doesn't exist or isn't a directory on this machine." },
      { status: 400 },
    );
  }

  try {
    const [updated] = await db
      .update(projects)
      .set({ localPath })
      .where(eq(projects.id, projectId))
      .returning();
    if (!updated) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    return NextResponse.json({ project: updated });
  } catch (err) {
    logger.error("PATCH /api/projects failed", err);
    return NextResponse.json({ error: "Failed to save local path." }, { status: 500 });
  }
}
