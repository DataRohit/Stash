import type { Metadata } from "next";
import { ErrorCodePage } from "@/components/error/error-code-page";

export const metadata: Metadata = {
  title: "404",
  description: "The requested workspace page could not be found.",
};

export default function DashboardNotFound() {
  return (
    <ErrorCodePage
      code="404"
      title="This workspace page could not be found."
      description="The page you requested does not exist, may have moved, or is not available from this workspace."
    />
  );
}
