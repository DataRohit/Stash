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

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const [{ token }, headerList] = await Promise.all([context.params, headers()]);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (!cursor) return Response.json({ error: "cursor-required" }, { status: 400 });
  const result = await fetchSharedProject(
    token,
    url.searchParams.get("document") ?? undefined,
    cursor,
    clientIp(headerList),
  );
  if (result?.status !== "ok")
    return Response.json({ error: result?.status ?? "unavailable" }, { status: 404 });
  return Response.json(
    {
      nodes: result.nodes.map((node) => ({
        ...node,
        assetUrl:
          node.kind === "asset" ? `/api/shares/project/${token}/assets/${node.id}` : node.assetUrl,
      })),
      nextCursor: result.nextCursor,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
