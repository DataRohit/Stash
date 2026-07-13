"use client";

import { ErrorCodePage } from "@/components/error/error-code-page";

export default function EditorError() {
  return (
    <ErrorCodePage
      code="500"
      title="This document could not load."
      description="Your local editor view was interrupted. Reload the document to reconnect to the latest saved state."
      onRetry={() => window.location.reload()}
      retryLabel="Reload document"
    />
  );
}
