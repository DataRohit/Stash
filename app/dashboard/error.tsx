"use client";

import { ErrorCodePage } from "@/components/error/error-code-page";

export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorCodePage
      code="500"
      title="This workspace view could not load."
      description="Something interrupted the request. You can try again or return to a stable Stash page."
      onRetry={reset}
    />
  );
}
