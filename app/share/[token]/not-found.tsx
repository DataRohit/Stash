import type { Metadata } from "next";
import { SharedEmptyState } from "@/app/share/[token]/shared-empty-state";

export const metadata: Metadata = {
  title: "Share link unavailable",
};

export default function ShareNotFound() {
  return (
    <SharedEmptyState
      title="Share link unavailable"
      body="This document is private, revoked, deleted, or the link is invalid."
    />
  );
}
