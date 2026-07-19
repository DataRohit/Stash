"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "@/convex/_generated/api";
import { clearOfflineDocuments } from "@/lib/offline-document-storage";

export function OfflinePolicyProvider() {
  const { isLoaded, orgId, userId } = useAuth();
  const organization = useQuery(
    api.organizations.get,
    isLoaded && orgId ? { clerkOrgId: orgId } : "skip",
  );
  const clearedPolicy = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !orgId || !userId || organization === undefined) return;
    const key = `${orgId}:${userId}`;
    if (organization?.offlineCachingEnabled === true) {
      if (clearedPolicy.current === key) clearedPolicy.current = null;
      return;
    }
    if (clearedPolicy.current === key) return;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 1_000;
    const clear = async () => {
      try {
        await clearOfflineDocuments({ organizationId: orgId, userId });
        if (active) clearedPolicy.current = key;
      } catch {
        if (!active) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          retryMs = Math.min(30_000, retryMs * 2);
          void clear();
        }, retryMs);
      }
    };
    void clear();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isLoaded, orgId, userId, organization]);

  return null;
}
