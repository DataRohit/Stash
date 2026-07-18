import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { apiClient, apiError, authorizeApiRequest } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const authorization = await authorizeApiRequest(request, "documents:read");
  if (!authorization)
    return apiError(401, "unauthorized", "A valid documents:read API key is required.");
  if (authorization.rateLimited) return apiError(429, "rate_limited", "API rate limit exceeded.");
  const configured = apiClient();
  if (!configured) return apiError(503, "unconfigured", "The API service is unavailable.");
  const { projectId } = await context.params;
  const url = new URL(request.url);
  const result = await configured.client
    .query(api.apiSurface.listDocuments, {
      secret: configured.secret,
      clerkOrgId: authorization.clerkOrgId,
      projectId: projectId as Id<"projects">,
      cursor: url.searchParams.get("cursor"),
      limit: Number(url.searchParams.get("limit") ?? 50),
    })
    .catch(() => null);
  if (!result) return apiError(404, "not_found", "Project not found.");
  return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const authorization = await authorizeApiRequest(request, "documents:write");
  if (!authorization)
    return apiError(401, "unauthorized", "A valid documents:write API key is required.");
  if (authorization.rateLimited) return apiError(429, "rate_limited", "API rate limit exceeded.");
  const configured = apiClient();
  if (!configured) return apiError(503, "unconfigured", "The API service is unavailable.");
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    content?: unknown;
    parentId?: unknown;
  } | null;
  if (
    !body ||
    typeof body.name !== "string" ||
    (body.content !== undefined && typeof body.content !== "string") ||
    (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== "string")
  ) {
    return apiError(
      400,
      "invalid_request",
      "name, optional content, and optional parentId are required in the documented format.",
    );
  }
  const { projectId } = await context.params;
  try {
    const result = await configured.client.mutation(api.apiSurface.createMarkdown, {
      secret: configured.secret,
      clerkOrgId: authorization.clerkOrgId,
      projectId: projectId as Id<"projects">,
      parentId: (body.parentId ?? null) as Id<"documents"> | null,
      name: body.name,
      content: body.content ?? "",
      actorKeyId: authorization.keyId as Id<"apiKeys">,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "write-failed";
    if (code.includes("not-found") || code.includes("Validator error")) {
      return apiError(404, "not_found", "Project or parent folder not found.");
    }
    return apiError(422, "write_failed", "The document could not be created.");
  }
}
