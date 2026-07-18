import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminWorkspace } from "./workspace";

export const metadata: Metadata = { title: "Trust and usage" };

export default async function AdminPage() {
  const { isAuthenticated, orgId, orgRole } = await auth();
  if (!isAuthenticated) redirect("/sign-in");
  if (!orgId) redirect("/onboarding");
  if (orgRole !== "org:admin") redirect("/dashboard");
  return <AdminWorkspace clerkOrgId={orgId} />;
}
