import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { unsubscribeNotificationEmail } from "@/lib/convex-server";
import { logServerError } from "@/lib/server-log";

export const dynamic = "force-dynamic";

const kinds = new Set(["mention", "reply", "resolved", "reopened", "watching", "digest"] as const);

function page(title: string, detail: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui;max-width:34rem;margin:10vh auto;padding:1.5rem;color:#171717"><h1>${title}</h1><p>${detail}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const signature = request.nextUrl.searchParams.get("signature") ?? "";
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  if (!secret || secret.length < 32 || !/^[a-f0-9]{64}$/.test(signature)) {
    return page(
      "Link unavailable",
      "This unsubscribe link is invalid or no longer configured.",
      400,
    );
  }
  let payload: string;
  try {
    payload = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return page("Link unavailable", "This unsubscribe link is invalid.", 400);
  }
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return page("Link unavailable", "This unsubscribe link is invalid.", 400);
  }
  const [userId, clerkOrgId, rawKind, rawExpires] = payload.split(".");
  const expires = Number(rawExpires);
  if (
    !userId ||
    !clerkOrgId ||
    !kinds.has(rawKind as never) ||
    !Number.isFinite(expires) ||
    expires < Date.now()
  ) {
    return page("Link expired", "Open Stash notification settings to update your choices.", 400);
  }
  try {
    await unsubscribeNotificationEmail({
      userId,
      clerkOrgId,
      kind: rawKind as "mention" | "reply" | "resolved" | "reopened" | "watching" | "digest",
    });
    return page("Email preference updated", "You will no longer receive this kind of email.");
  } catch (error) {
    logServerError("email.unsubscribe_failed", error, { clerkOrgId, userId });
    return page("Couldn’t update your preference", "Please try again or use Stash settings.", 500);
  }
}
