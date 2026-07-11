import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { GlobalSearchPage } from "./search-page";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage() {
  const { isAuthenticated, orgId } = await auth();
  if (!isAuthenticated) redirect("/sign-in");
  if (!orgId) redirect("/onboarding");
  return <GlobalSearchPage clerkOrgId={orgId} />;
}
