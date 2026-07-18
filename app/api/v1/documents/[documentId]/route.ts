import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { apiClient, apiError, authorizeApiRequest } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const authorization = await authorizeApiRequest(request, "documents:read");
  if (!authorization)
    return apiError(401, "unauthorized", "A valid documents:read API key is required.");
  if (authorization.rateLimited) return apiError(429, "rate_limited", "API rate limit exceeded.");
  const configured = apiClient();
  if (!configured) return apiError(503, "unconfigured", "The API service is unavailable.");
  const { documentId } = await context.params;
  const result = await configured.client
    .query(api.apiSurface.getDocument, {
      secret: configured.secret,
      clerkOrgId: authorization.clerkOrgId,
      documentId: documentId as Id<"documents">,
    })
    .catch(() => null);
  if (!result) return apiError(404, "not_found", "Document not found.");
  return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const authorization = await authorizeApiRequest(request, "documents:write");
  if (!authorization)
    return apiError(401, "unauthorized", "A valid documents:write API key is required.");
  if (authorization.rateLimited) return apiError(429, "rate_limited", "API rate limit exceeded.");
  const configured = apiClient();
  if (!configured) return apiError(503, "unconfigured", "The API service is unavailable.");
  const body = (await request.json().catch(() => null)) as { append?: unknown } | null;
  if (!body || typeof body.append !== "string" || body.append.length === 0) {
    return apiError(400, "invalid_request", "A non-empty append string is required.");
  }
  const { documentId } = await context.params;
  try {
    const result = await configured.client.mutation(api.apiSurface.appendMarkdown, {
      secret: configured.secret,
      clerkOrgId: authorization.clerkOrgId,
      documentId: documentId as Id<"documents">,
      content: body.append,
      actorKeyId: authorization.keyId as Id<"apiKeys">,
    });
    return Response.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "write-failed";
    if (code.includes("not-found") || code.includes("Validator error")) {
      return apiError(404, "not_found", "Document not found.");
    }
    return apiError(422, "write_failed", "The document could not be updated.");
  }
}
