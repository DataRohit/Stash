import { auth } from "@clerk/nextjs/server";
import { fetchAuditExport } from "@/lib/convex-server";

export const dynamic = "force-dynamic";

function cell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const { isAuthenticated, orgId, orgRole } = await auth();
  if (!isAuthenticated) return new Response("Unauthorized", { status: 401 });
  if (!orgId || orgRole !== "org:admin") return new Response("Forbidden", { status: 403 });
  const url = new URL(request.url);
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));
  const result = await fetchAuditExport(orgId, {
    kind: url.searchParams.get("kind") || undefined,
    actorUserId: url.searchParams.get("actor") || undefined,
    projectId: url.searchParams.get("project") || undefined,
    from: Number.isFinite(from) && from > 0 ? from : undefined,
    to: Number.isFinite(to) && to > 0 ? to : undefined,
  });
  if (result.truncated) {
    return Response.json(
      { error: "The export exceeds 5,000 rows. Narrow the date range before exporting." },
      { status: 413 },
    );
  }
  const rows = [
    ["Timestamp", "Actor ID", "Actor", "Action", "Project", "Target ID", "Target", "Metadata"],
    ...result.items.map((event) => [
      new Date(event.createdAt).toISOString(),
      event.actorUserId,
      event.actorName,
      event.kind,
      event.projectName,
      event.targetId,
      event.targetName,
      event.metadata,
    ]),
  ];
  return new Response(rows.map((row) => row.map(cell).join(",")).join("\r\n"), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="stash-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Content-Type": "text/csv; charset=utf-8",
    },
  });
}
