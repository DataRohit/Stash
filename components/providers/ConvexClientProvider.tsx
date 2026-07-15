"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import type { ReactNode } from "react";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!convex) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <section role="alert" className="glass max-w-lg rounded-lg p-8 text-center">
          <h1 className="font-serif text-2xl tracking-display">Workspace unavailable</h1>
          <p className="mt-3 text-muted-foreground text-sm leading-relaxed">
            The realtime data service is not configured. Set NEXT_PUBLIC_CONVEX_URL and restart the
            application.
          </p>
        </section>
      </main>
    );
  }
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
