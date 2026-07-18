import { api } from "@/convex/_generated/api";
import { apiClient, apiError, authorizeApiRequest } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = await authorizeApiRequest(request, "projects:read");
  if (!authorization)
    return apiError(401, "unauthorized", "A valid projects:read API key is required.");
  if (authorization.rateLimited) return apiError(429, "rate_limited", "API rate limit exceeded.");
  const configured = apiClient();
  if (!configured) return apiError(503, "unconfigured", "The API service is unavailable.");
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const result = await configured.client.query(api.apiSurface.listProjects, {
    secret: configured.secret,
    clerkOrgId: authorization.clerkOrgId,
    cursor: url.searchParams.get("cursor"),
    limit,
  });
  return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
}
