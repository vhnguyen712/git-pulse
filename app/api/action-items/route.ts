import { NextResponse } from "next/server";
import { deleteActionItem } from "@/lib/action-items";
import { deleteActionItemRequestSchema } from "@/lib/schema";
import { logger } from "@/lib/logging";

export async function DELETE(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = deleteActionItemRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "actionItemId is required." }, { status: 400 });
  }

  try {
    const deleted = await deleteActionItem(parsed.data.actionItemId);
    if (!deleted) {
      return NextResponse.json({ error: "Action item not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("DELETE /api/action-items failed", err);
    return NextResponse.json({ error: "Failed to remove action item." }, { status: 500 });
  }
}
