"use client";

import { ErrorCodePage } from "@/components/error/error-code-page";

export default function SharedDocumentError() {
  return (
    <ErrorCodePage
      code="500"
      title="This shared document could not load."
      description="The shared view was interrupted. Reload the document to try the link again."
      onRetry={() => window.location.reload()}
      retryLabel="Reload document"
      showDashboard={false}
    />
  );
}
