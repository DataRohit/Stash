import { NextResponse } from "next/server";
import { leaveDocumentPresence } from "@/lib/convex-server";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { documentId?: string; sessionId?: string };
    if (!body.documentId || !body.sessionId) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    await leaveDocumentPresence(body.documentId, body.sessionId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
