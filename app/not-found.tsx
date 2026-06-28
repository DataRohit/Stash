import type { Metadata } from "next";
import { ErrorCodePage } from "@/components/error/error-code-page";

export const metadata: Metadata = {
  title: "404",
  description: "The requested Stash page could not be found.",
};

export default function NotFound() {
  return (
    <ErrorCodePage
      code="404"
      title="This page slipped out of the stack."
      description="The page you requested does not exist, may have moved, or is not available from this workspace."
    />
  );
}
