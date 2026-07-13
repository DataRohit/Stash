import { ConvexHttpClient } from "convex/browser";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";

export const dynamic = "force-dynamic";

const DEEP_TIMEOUT_MS = 2_000;

async function convexReachable(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    return false;
  }
  const client = new ConvexHttpClient(url);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timeoutId = setTimeout(() => resolve(false), DEEP_TIMEOUT_MS);
  });
  const ping = client
    .query(api.health.ping, {})
    .then((result) => result.ok)
    .catch(() => false);
  const reachable = await Promise.race([ping, timeout]);
  clearTimeout(timeoutId);
  return reachable;
}

export async function GET(request: NextRequest) {
  const ts = new Date().toISOString();
  if (request.nextUrl.searchParams.get("deep") !== "1") {
    return NextResponse.json({ ok: true, convex: null, ts });
  }
  const convex = await convexReachable();
  return NextResponse.json({ ok: convex, convex, ts }, { status: convex ? 200 : 503 });
}
