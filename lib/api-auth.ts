import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

export type ApiAuthorization = {
  rateLimited: false;
  keyId: string;
  clerkOrgId: string;
  scopes: string[];
};

export function apiClient(): { client: ConvexHttpClient; secret: string } | null {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.CONVEX_PURGE_SECRET;
  if (!url || !secret) return null;
  return { client: new ConvexHttpClient(url), secret };
}

export async function authorizeApiRequest(
  request: Request,
  requiredScope: string,
): Promise<ApiAuthorization | { rateLimited: true } | null> {
  const configured = apiClient();
  if (!configured) return null;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const key = authorization.slice(7).trim();
  return await configured.client.mutation(api.apiKeys.authorize, {
    secret: configured.secret,
    key,
    requiredScope,
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
