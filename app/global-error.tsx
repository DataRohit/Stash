"use client";

import { ErrorCodePage } from "@/components/error/error-code-page";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="page-enter">
        <ErrorCodePage
          code="500"
          title="Stash could not recover this screen."
          description="A critical rendering error stopped the app shell. Try again, or return to the landing page."
          onRetry={reset}
        />
      </body>
    </html>
  );
}
