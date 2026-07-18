import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { apiClient, apiError, authorizeApiRequest } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

type PropertyValue =
  | { type: "text"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "date"; value: number; endValue?: number }
  | { type: "status"; optionId: string }
  | { type: "person"; userId: string };

export async function PUT(
  request: Request,
  context: { params: Promise<{ documentId: string; propertyId: string }> },
) {
  const authorization = await authorizeApiRequest(request, "properties:write");
  if (!authorization)
    return apiError(401, "unauthorized", "A valid properties:write API key is required.");
  if (authorization.rateLimited) return apiError(429, "rate_limited", "API rate limit exceeded.");
  const configured = apiClient();
  if (!configured) return apiError(503, "unconfigured", "The API service is unavailable.");
  const value = (await request.json().catch(() => null)) as PropertyValue | null;
  if (!value || !["text", "number", "boolean", "date", "status", "person"].includes(value.type)) {
    return apiError(400, "invalid_request", "A supported typed property value is required.");
  }
  const { documentId, propertyId } = await context.params;
  try {
    const result = await configured.client.mutation(api.apiSurface.setProperty, {
      secret: configured.secret,
      clerkOrgId: authorization.clerkOrgId,
      documentId: documentId as Id<"documents">,
      propertyId: propertyId as Id<"documentProperties">,
      value,
      actorKeyId: authorization.keyId as Id<"apiKeys">,
    });
    return Response.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "write-failed";
    if (code.includes("not-found") || code.includes("Validator error")) {
      return apiError(404, "not_found", "Document or property not found.");
    }
    return apiError(422, "write_failed", "The property value could not be updated.");
  }
}
