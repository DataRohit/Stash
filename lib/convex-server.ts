import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

export type OrgDetails = {
  description: string;
  tags: string[];
};

const EMPTY_DETAILS: OrgDetails = { description: "", tags: [] };

async function authedClient(): Promise<ConvexHttpClient | null> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    return null;
  }
  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  const client = new ConvexHttpClient(url);
  if (token) {
    client.setAuth(token);
  }
  return client;
}

export async function fetchOrgDetails(clerkOrgId: string): Promise<OrgDetails> {
  try {
    const client = await authedClient();
    if (!client) {
      return EMPTY_DETAILS;
    }
    const result = await client.query(api.organizations.get, { clerkOrgId });
    return result ?? EMPTY_DETAILS;
  } catch {
    return EMPTY_DETAILS;
  }
}

export async function saveOrgDetails(
  clerkOrgId: string,
  description: string,
  tags: string[],
): Promise<void> {
  const client = await authedClient();
  if (!client) {
    throw new Error("Convex is not configured");
  }
  await client.mutation(api.organizations.upsertDetails, { clerkOrgId, description, tags });
}

export async function removeOrgDetails(clerkOrgId: string): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.organizations.remove, { clerkOrgId });
}
