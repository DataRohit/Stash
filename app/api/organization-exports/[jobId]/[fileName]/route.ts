import { auth } from "@clerk/nextjs/server";
import { fetchOrganizationExportUrl } from "@/lib/convex-server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string; fileName: string }> },
) {
  const { isAuthenticated, orgId, orgRole } = await auth();
  if (!isAuthenticated) return new Response("Unauthorized", { status: 401 });
  if (!orgId || orgRole !== "org:admin") return new Response("Forbidden", { status: 403 });
  const { jobId, fileName } = await context.params;
  const url = await fetchOrganizationExportUrl(orgId, jobId, fileName);
  if (!url) return new Response("Export unavailable or expired", { status: 404 });
  const response = await fetch(url, { cache: "no-store", redirect: "error" });
  if (!response.ok || !response.body) return new Response("Export unavailable", { status: 502 });
  const safeName = fileName.replace(/[\r\n"\\/]/g, "-").slice(0, 160);
  return new Response(response.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Type": fileName.endsWith(".json") ? "application/json" : "application/zip",
    },
  });
}
