import { isIP } from "node:net";
import { headers } from "next/headers";
import { fetchSharedProject } from "@/lib/convex-server";

export const dynamic = "force-dynamic";

function clientIp(headersList: Headers): string {
  const direct = headersList.get("x-real-ip")?.trim();
  if (direct && isIP(direct)) return direct.slice(0, 128);
  if (process.env.SHARE_TRUST_FORWARDED === "1") {
    const forwarded = headersList.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
    if (forwarded && isIP(forwarded)) return forwarded.slice(0, 128);
  }
  return "unknown";
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string; documentId: string }> },
) {
  const [{ token, documentId }, headerList] = await Promise.all([context.params, headers()]);
  const result = await fetchSharedProject(token, documentId, undefined, clientIp(headerList));
  if (result?.status !== "ok" || result.document?.kind !== "asset" || !result.document.assetUrl)
    return new Response("Asset unavailable", { status: 404 });
  const response = await fetch(result.document.assetUrl, { cache: "no-store", redirect: "error" });
  if (!response.ok || !response.body) return new Response("Asset unavailable", { status: 502 });
  return new Response(response.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${result.document.name.replace(/[\r\n"\\/]/g, "-")}"`,
      "Content-Type": result.document.mimeType ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
