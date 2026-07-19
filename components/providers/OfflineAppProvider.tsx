"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";
import { notify } from "@/components/ui/toast";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const VISIT_COUNT_KEY = "stash:pwa-visits";
const INSTALL_DISMISSED_KEY = "stash:pwa-install-dismissed";
const LAST_USER_KEY = "stash:last-authenticated-user";
const COLLAB_STORAGE_PREFIX = "stash:collab-outbox:";

async function clearLocalDocuments(userId: string): Promise<void> {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(COLLAB_STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {}
  const { clearOfflineDocuments } = await import("@/lib/offline-document-storage");
  await clearOfflineDocuments({ userId });
}

function readStorage(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {}
}

function isInstalled(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true)
  );
}

export function OfflineAppProvider() {
  const { isLoaded, userId } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;
    const previousUserId = readStorage(localStorage, LAST_USER_KEY);
    if (!previousUserId || previousUserId === userId) {
      writeStorage(localStorage, LAST_USER_KEY, userId ?? null);
      return;
    }
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 1_000;
    const clear = async () => {
      try {
        await clearLocalDocuments(previousUserId);
        if (active) writeStorage(localStorage, LAST_USER_KEY, userId ?? null);
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
  }, [isLoaded, userId]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    let active = true;
    let installPrompt: InstallPromptEvent | null = null;
    const visits = Number.parseInt(readStorage(localStorage, VISIT_COUNT_KEY) ?? "0", 10);
    const nextVisits = Number.isFinite(visits) ? Math.min(visits + 1, 100) : 1;
    writeStorage(localStorage, VISIT_COUNT_KEY, String(nextVisits));

    const announceWaitingWorker = (registration: ServiceWorkerRegistration) => {
      if (!registration.waiting) return;
      notify.info("A new Stash version is ready", {
        description: "Refresh when convenient to use the latest application shell.",
        action: {
          label: "Refresh",
          onClick: () => registration.waiting?.postMessage({ type: "SKIP_WAITING" }),
        },
      });
    };

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        if (!active) return;
        announceWaitingWorker(registration);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              announceWaitingWorker(registration);
            }
          });
        });
      } catch {
        notify.warning("Offline shell unavailable", {
          description:
            "Stash is still usable online. Installation can be retried on a later visit.",
        });
      }
    };

    const onControllerChange = () => window.location.reload();
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      installPrompt = event as InstallPromptEvent;
      if (
        nextVisits < 2 ||
        isInstalled() ||
        readStorage(sessionStorage, INSTALL_DISMISSED_KEY) === "1"
      ) {
        return;
      }
      notify.info("Install Stash on this device", {
        description: "Open your workspace from an app icon with a faster cached shell.",
        action: {
          label: "Install",
          onClick: () => {
            const prompt = installPrompt;
            installPrompt = null;
            if (!prompt) return;
            void prompt.prompt().then(async () => {
              const choice = await prompt.userChoice;
              if (choice.outcome === "dismissed") {
                writeStorage(sessionStorage, INSTALL_DISMISSED_KEY, "1");
              }
            });
          },
        },
      });
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    void register();
    return () => {
      active = false;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
    };
  }, []);

  return null;
}
