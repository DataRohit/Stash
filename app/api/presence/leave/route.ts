import { NextResponse } from "next/server";
import { leaveDocumentPresence } from "@/lib/convex-server";

const ID_PATTERN = /^[a-z0-9:_-]{8,128}$/i;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { documentId?: string; sessionId?: string };
    if (
      !body.documentId ||
      !body.sessionId ||
      !ID_PATTERN.test(body.documentId) ||
      !ID_PATTERN.test(body.sessionId)
    ) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    await leaveDocumentPresence(body.documentId, body.sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message.includes("Forbidden") || message.includes("unauthenticated") ? 401 : 500;
    return NextResponse.json({ ok: false }, { status });
  }
}
