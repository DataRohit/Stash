import { ConvexHttpClient } from "convex/browser";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { secretMatches } from "@/convex/secrets";

export const dynamic = "force-dynamic";

const DEEP_TIMEOUT_MS = 2_000;

function isUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function configurationChecks() {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  const webhookSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  const publishableKeyValid = /^pk_(?:test|live)_/.test(publishableKey ?? "");
  const secretKeyValid = /^sk_(?:test|live)_/.test(secretKey ?? "");
  const productionKeys =
    process.env.NODE_ENV !== "production" ||
    (!publishableKey?.startsWith("pk_test_") && !secretKey?.startsWith("sk_test_"));
  return {
    siteUrl: isUrl(process.env.NEXT_PUBLIC_SITE_URL),
    convexUrl: isUrl(process.env.NEXT_PUBLIC_CONVEX_URL),
    clerkPublishableKey: publishableKeyValid,
    clerkSecretKey: secretKeyValid,
    clerkIssuer: isUrl(process.env.CLERK_JWT_ISSUER_DOMAIN),
    clerkWebhookSecret: webhookSecret?.startsWith("whsec_") === true,
    purgeSecret: (process.env.CONVEX_PURGE_SECRET?.length ?? 0) >= 32,
    healthCheckToken: (process.env.HEALTH_CHECK_TOKEN?.length ?? 0) >= 32,
    shareIpSalt: (process.env.SHARE_IP_SALT?.length ?? 0) >= 32,
    productionKeys,
  };
}

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
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secretMatches(token, process.env.HEALTH_CHECK_TOKEN)) {
    return NextResponse.json({ ok: true, convex: null, ts });
  }
  const checks = configurationChecks();
  const configured = Object.values(checks).every(Boolean);
  const convex = await convexReachable();
  const ok = configured && convex;
  return NextResponse.json({ ok, configured, convex, checks, ts }, { status: ok ? 200 : 503 });
}
