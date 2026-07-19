"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { mapDocError } from "@/app/dashboard/projects/[id]/editor/lib/editor-format";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  clearOfflineDocument,
  closeOfflineDocument,
  markOfflineDocumentAvailable,
  type OfflineDocumentHandle,
  openOfflineDocument,
  subscribeToOfflineClear,
} from "@/lib/offline-document-storage";

const CURSOR_COLORS = [
  { color: "#b91c1c", light: "#b91c1c33" },
  { color: "#1d4ed8", light: "#1d4ed833" },
  { color: "#15803d", light: "#15803d33" },
  { color: "#7e22ce", light: "#7e22ce33" },
  { color: "#be185d", light: "#be185d33" },
  { color: "#0e7490", light: "#0e749033" },
  { color: "#a16207", light: "#a1620733" },
  { color: "#c2410c", light: "#c2410c33" },
  { color: "#4338ca", light: "#4338ca33" },
  { color: "#047857", light: "#04785733" },
  { color: "#a21caf", light: "#a21caf33" },
  { color: "#0369a1", light: "#0369a133" },
  { color: "#4d7c0f", light: "#4d7c0f33" },
  { color: "#6d28d9", light: "#6d28d933" },
  { color: "#9f1239", light: "#9f123933" },
  { color: "#0f766e", light: "#0f766e33" },
  { color: "#854d0e", light: "#854d0e33" },
];
const DEFAULT_CURSOR_COLOR = { color: "#1d4ed8", light: "#1d4ed833" };

const FLUSH_MS = 200;
const MAX_RETRY_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const OUTBOX_PREFIX = "stash:collab-outbox:v2:";
const LEGACY_OUTBOX_PREFIX = "stash:collab-outbox:";

export type CollabViewer = {
  sessionId: string;
  userId: string;
  name: string;
  email: string | null;
  color: string;
  image: string | null;
  role: string;
  isSelf: boolean;
};

type CollabUser = { id: string; name: string; email: string | null; image: string | null };

type Engine = { ydoc: Y.Doc; ytext: Y.Text; awareness: Awareness };
type CursorColor = (typeof CURSOR_COLORS)[number];

type CollabDoc = {
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
  ready: boolean;
  online: boolean;
  offlineAvailable: boolean;
  storageDegraded: boolean;
  syncing: boolean;
  blocked: string | null;
  pendingEdits: number;
  lastSyncedAt: Date | null;
  viewers: CollabViewer[];
  sessionId: string | null;
  userLabel: string;
  color: string;
  colorLight: string;
  seq: number;
};

function colorForUser(seed: string): CursorColor {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length] ?? DEFAULT_CURSOR_COLOR;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function readOutbox(value: string): Uint8Array {
  try {
    const parsed = JSON.parse(value) as { update?: unknown };
    if (typeof parsed.update === "string") {
      return base64ToBytes(parsed.update);
    }
  } catch {}
  return base64ToBytes(value);
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

function reportAsync(error: unknown): void {
  if (process.env.NODE_ENV === "development") {
    console.error(error);
  }
}

function beaconLeave(documentId: string, sessionId: string): void {
  const body = JSON.stringify({ documentId, sessionId });
  if (navigator.sendBeacon) {
    const payload = new Blob([body], { type: "application/json" });
    navigator.sendBeacon("/api/presence/leave", payload);
    return;
  }
  void fetch("/api/presence/leave", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
    keepalive: true,
  }).catch(reportAsync);
}

export function useCollabDoc(
  documentId: string | null,
  canEdit: boolean,
  user: CollabUser,
  organizationId: string,
  offlineCachingEnabled?: boolean,
): CollabDoc | null {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [offlineAvailable, setOfflineAvailable] = useState(false);
  const [storageDegraded, setStorageDegraded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [pendingEdits, setPendingEdits] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [seq, setSeq] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pullCursor, setPullCursor] = useState<{ documentId: string | null; afterSeq: number }>({
    documentId: null,
    afterSeq: 0,
  });
  const queryAfterSeq =
    documentId && pullCursor.documentId === documentId ? pullCursor.afterSeq : 0;

  const pullResult = useQuery(
    api.collab.pullUpdates,
    documentId ? { documentId: documentId as Id<"documents">, afterSeq: queryAfterSeq } : "skip",
  );
  const presenceResult = useQuery(
    api.presence.list,
    documentId ? { documentId: documentId as Id<"documents"> } : "skip",
  );
  const pushUpdateV2 = useMutation(api.collab.pushUpdateV2);
  const ensureSeed = useMutation(api.collab.ensureSeed);
  const createHistoryCheckpoint = useMutation(api.collab.createHistoryCheckpoint);
  const heartbeat = useMutation(api.presence.heartbeat);
  const leavePresence = useMutation(api.presence.leave);

  const appliedSeq = useRef(0);
  const seeded = useRef(false);
  const persistenceRef = useRef<OfflineDocumentHandle | null>(null);
  const cacheValidated = useRef(false);
  const userColor = useMemo(() => colorForUser(user.id), [user.id]);
  const userLabel = useMemo(
    () => (user.email ? `${user.name} · ${user.email}` : user.name),
    [user.name, user.email],
  );

  useEffect(() => {
    setSessionId(createSessionId());
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!documentId || !sessionId) {
      setEngine(null);
      setReady(false);
      setPersistenceReady(false);
      setOfflineAvailable(false);
      setStorageDegraded(false);
      setSyncing(false);
      setPendingEdits(0);
      setLastSyncedAt(null);
      setSeq(0);
      return;
    }
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("codemirror");
    const awareness = new Awareness(ydoc);
    appliedSeq.current = 0;
    seeded.current = false;
    cacheValidated.current = false;
    setPullCursor({ documentId, afterSeq: 0 });
    setReady(false);
    setPersistenceReady(false);
    setOfflineAvailable(false);
    setStorageDegraded(false);
    setSyncing(false);
    setBlocked(null);
    setPendingEdits(0);
    setLastSyncedAt(null);
    setSeq(0);
    setEngine({ ydoc, ytext, awareness });
    return () => {
      awareness.destroy();
      ydoc.destroy();
    };
  }, [documentId, sessionId]);

  useEffect(() => {
    if (!engine) {
      return;
    }
    engine.awareness.setLocalStateField("user", {
      name: userLabel,
      color: userColor.color,
      colorLight: userColor.light,
      sessionId,
    });
  }, [engine, userLabel, userColor, sessionId]);

  useEffect(() => {
    if (!engine || !documentId || !sessionId || offlineCachingEnabled === undefined) return;
    if (!offlineCachingEnabled) {
      setPersistenceReady(true);
      setOfflineAvailable(false);
      setStorageDegraded(false);
      return;
    }
    const identity = { organizationId, userId: user.id, documentId };
    let active = true;
    setPersistenceReady(false);
    setStorageDegraded(false);
    const unsubscribe = subscribeToOfflineClear(identity, () => {
      const handle = persistenceRef.current;
      if (handle?.identity.documentId !== documentId) return;
      persistenceRef.current = null;
      cacheValidated.current = false;
      setOfflineAvailable(false);
      if (!navigator.onLine) setReady(false);
      void clearOfflineDocument(handle).catch(reportAsync);
    });
    void openOfflineDocument(identity, engine.ydoc)
      .then(async (handle) => {
        if (!active) {
          await closeOfflineDocument(handle);
          return;
        }
        persistenceRef.current = handle;
        cacheValidated.current = handle.available;
        setOfflineAvailable(handle.available);
        if (handle.available) setReady(true);
        setPersistenceReady(true);
      })
      .catch((error) => {
        if (!active) return;
        setStorageDegraded(true);
        setOfflineAvailable(false);
        setPersistenceReady(true);
        reportAsync(error);
      });
    return () => {
      active = false;
      unsubscribe();
      const handle = persistenceRef.current;
      if (handle?.identity.documentId === documentId) {
        persistenceRef.current = null;
        void closeOfflineDocument(handle).catch(reportAsync);
      }
    };
  }, [engine, documentId, sessionId, organizationId, user.id, offlineCachingEnabled]);

  useEffect(() => {
    if (!engine || !documentId || !canEdit || !sessionId || !persistenceReady) {
      return;
    }
    const { ydoc } = engine;
    let pending: Uint8Array[] = [];
    let pendingEditCount = 0;
    let inFlight: Uint8Array | null = null;
    let inFlightEditCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failureNotified = false;
    let reconnecting = false;
    let retryMs = FLUSH_MS;
    let active = true;
    const userOutboxPrefix = `${OUTBOX_PREFIX}${organizationId}:${user.id}:`;
    const outboxPrefix = `${userOutboxPrefix}${documentId}:`;
    const legacyOutboxPrefix = `${LEGACY_OUTBOX_PREFIX}${documentId}:${user.id}:`;
    const outboxKey = `${outboxPrefix}${sessionId}`;
    const recoveredEntries = new Map<string, string>();
    const persistOutbox = () => {
      try {
        if (offlineCachingEnabled === false) {
          localStorage.removeItem(outboxKey);
          clearRecoveredEntries();
          return;
        }
        if (offlineCachingEnabled !== true) return;
        const updates = inFlight ? [inFlight, ...pending] : pending;
        if (updates.length === 0) {
          localStorage.removeItem(outboxKey);
          return;
        }
        localStorage.setItem(
          outboxKey,
          JSON.stringify({
            createdAt: Date.now(),
            update: bytesToBase64(Y.mergeUpdates(updates)),
          }),
        );
      } catch (error) {
        reportAsync(error);
      }
    };
    const clearRecoveredEntries = () => {
      try {
        for (const [key, value] of recoveredEntries) {
          if (key !== outboxKey && localStorage.getItem(key) === value) {
            localStorage.removeItem(key);
          }
        }
        recoveredEntries.clear();
      } catch (error) {
        reportAsync(error);
      }
    };
    try {
      if (offlineCachingEnabled !== true) {
        for (let index = localStorage.length - 1; index >= 0; index -= 1) {
          const key = localStorage.key(index);
          if (
            offlineCachingEnabled === false &&
            (key?.startsWith(userOutboxPrefix) || key?.startsWith(legacyOutboxPrefix))
          ) {
            localStorage.removeItem(key);
          }
        }
      } else {
        const recovered: Uint8Array[] = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key?.startsWith(outboxPrefix) && !key?.startsWith(legacyOutboxPrefix)) {
            continue;
          }
          const value = localStorage.getItem(key);
          if (!value) {
            continue;
          }
          try {
            recovered.push(readOutbox(value));
            recoveredEntries.set(key, value);
          } catch {
            localStorage.removeItem(key);
          }
        }
        if (recovered.length > 0) {
          const update = Y.mergeUpdates(recovered);
          Y.applyUpdate(ydoc, update, "recovery");
          pending = [update];
          pendingEditCount = 1;
          reconnecting = true;
          setSyncing(true);
          setPendingEdits(1);
          persistOutbox();
        }
      }
    } catch (error) {
      reportAsync(error);
    }
    const flush = async () => {
      timer = null;
      if (!navigator.onLine) {
        reconnecting = true;
        setOnline(false);
        setSyncing(false);
        setPendingEdits(pendingEditCount + inFlightEditCount);
        return;
      }
      if (inFlight || pending.length === 0) {
        if (!inFlight && pending.length === 0) {
          setSyncing(false);
        }
        return;
      }
      inFlight = Y.mergeUpdates(pending);
      inFlightEditCount = pendingEditCount;
      pending = [];
      pendingEditCount = 0;
      persistOutbox();
      setSyncing(true);
      let retryable = false;
      try {
        const result = await pushUpdateV2({
          documentId: documentId as Id<"documents">,
          update: toArrayBuffer(inFlight),
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        inFlight = null;
        inFlightEditCount = 0;
        failureNotified = false;
        const checkpointAfterReconnect = reconnecting;
        reconnecting = false;
        retryMs = FLUSH_MS;
        setOnline(true);
        setBlocked(null);
        setPendingEdits(pendingEditCount);
        setLastSyncedAt(new Date());
        setSeq(result.seq);
        clearRecoveredEntries();
        persistOutbox();
        if (checkpointAfterReconnect) {
          void createHistoryCheckpoint({ documentId: documentId as Id<"documents"> }).catch(
            reportAsync,
          );
        }
      } catch (error) {
        if (inFlight) {
          pending = [inFlight, ...pending];
          pendingEditCount += inFlightEditCount;
        }
        inFlight = null;
        inFlightEditCount = 0;
        persistOutbox();
        const message = error instanceof Error ? error.message : "";
        const blockedByLimit =
          message.includes("project-full") ||
          message.includes("file-too-large") ||
          message.includes("update-too-large") ||
          message.includes("too-many-cells") ||
          message.includes("too-many-cards") ||
          message.includes("invalid-update");
        if (blockedByLimit) {
          pending = [];
          pendingEditCount = 0;
          localStorage.removeItem(outboxKey);
          clearRecoveredEntries();
          setBlocked(mapDocError(error, "Your latest edit could not be synced. Please try again."));
          setPendingEdits(0);
          setSessionId(createSessionId());
        } else {
          retryable = true;
          reconnecting = true;
          retryMs = Math.min(MAX_RETRY_MS, Math.max(FLUSH_MS, retryMs * 2));
          setPendingEdits(pendingEditCount);
        }
        if (!failureNotified) {
          failureNotified = true;
          notify.error("Couldn’t sync changes", {
            description: mapDocError(
              error,
              "Your latest edit could not be synced. Please try again.",
            ),
          });
        }
        reportAsync(error);
      } finally {
        if (!inFlight && pending.length === 0) {
          setSyncing(false);
        } else if (retryable && active && timer === null) {
          timer = setTimeout(() => void flush(), retryMs);
        } else if (!inFlight && pending.length > 0 && active && timer === null) {
          timer = setTimeout(() => void flush(), FLUSH_MS);
        }
      }
    };
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || origin === "seed" || origin === "recovery") {
        return;
      }
      if (origin === persistenceRef.current?.provider) return;
      pending.push(update);
      pendingEditCount += 1;
      persistOutbox();
      if (reconnecting) {
        setPendingEdits(pendingEditCount);
      }
      setSyncing(true);
      if (timer === null) {
        timer = setTimeout(() => void flush(), FLUSH_MS);
      }
    };
    const onPageHide = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!inFlight && pending.length === 0) {
        return;
      }
      persistOutbox();
      event.preventDefault();
      event.returnValue = "";
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        onPageHide();
      }
    };
    const onOffline = () => {
      setOnline(false);
      persistOutbox();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      setSyncing(false);
      setPendingEdits(pendingEditCount + inFlightEditCount);
    };
    const onOnline = () => {
      setOnline(true);
      retryMs = FLUSH_MS;
      if ((pending.length > 0 || inFlight) && timer === null) {
        timer = setTimeout(() => void flush(), 0);
      }
    };
    ydoc.on("update", onUpdate);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    if (pending.length > 0) {
      timer = setTimeout(() => void flush(), 0);
    }
    return () => {
      active = false;
      ydoc.off("update", onUpdate);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      if (timer !== null) {
        clearTimeout(timer);
      }
      persistOutbox();
      void flush();
    };
  }, [
    engine,
    documentId,
    canEdit,
    pushUpdateV2,
    createHistoryCheckpoint,
    sessionId,
    user.id,
    organizationId,
    offlineCachingEnabled,
    persistenceReady,
  ]);

  useEffect(() => {
    if (!engine || !documentId || pullResult === undefined || !persistenceReady) {
      return;
    }
    if (!pullResult.authorized) {
      setReady(false);
      setBlocked("You no longer have access to this document.");
      const handle = persistenceRef.current;
      if (handle?.identity.documentId === documentId) {
        persistenceRef.current = null;
        cacheValidated.current = false;
        setOfflineAvailable(false);
        void clearOfflineDocument(handle).catch(reportAsync);
      }
      try {
        const prefix = `${OUTBOX_PREFIX}${organizationId}:${user.id}:${documentId}:`;
        const legacyPrefix = `${LEGACY_OUTBOX_PREFIX}${documentId}:${user.id}:`;
        for (let index = localStorage.length - 1; index >= 0; index -= 1) {
          const key = localStorage.key(index);
          if (key?.startsWith(prefix) || key?.startsWith(legacyPrefix))
            localStorage.removeItem(key);
        }
      } catch (error) {
        reportAsync(error);
      }
      return;
    }
    const { ydoc } = engine;
    let applied = false;
    if (pullResult.snapshot && appliedSeq.current === 0) {
      Y.applyUpdate(ydoc, new Uint8Array(pullResult.snapshot), "remote");
      appliedSeq.current = pullResult.throughSeq;
      applied = true;
    }
    for (const row of pullResult.updates) {
      if (row.seq > appliedSeq.current) {
        Y.applyUpdate(ydoc, new Uint8Array(row.update), "remote");
        appliedSeq.current = row.seq;
        applied = true;
      }
    }
    if (applied) {
      setReady(true);
    }
    const isEmpty = !pullResult.snapshot && pullResult.updates.length === 0;
    if (isEmpty) {
      setReady(true);
    }
    if (isEmpty && canEdit && !seeded.current) {
      seeded.current = true;
      void ensureSeed({ documentId: documentId as Id<"documents"> }).catch(reportAsync);
    }
    if (appliedSeq.current !== queryAfterSeq) {
      setPullCursor({ documentId, afterSeq: appliedSeq.current });
    }
    setSeq(appliedSeq.current);
    const handle = persistenceRef.current;
    if (handle && !cacheValidated.current) {
      cacheValidated.current = true;
      void markOfflineDocumentAvailable(handle)
        .then(() => setOfflineAvailable(true))
        .catch((error) => {
          cacheValidated.current = false;
          setStorageDegraded(true);
          reportAsync(error);
        });
    }
  }, [
    engine,
    documentId,
    pullResult,
    queryAfterSeq,
    canEdit,
    ensureSeed,
    user.id,
    organizationId,
    persistenceReady,
  ]);

  useEffect(() => {
    if (!engine || !presenceResult) {
      return;
    }
    const { awareness } = engine;
    const activeSessions = new Set<string>();
    for (const row of presenceResult) {
      activeSessions.add(row.sessionId);
      if (row.sessionId !== sessionId && row.state.length > 0) {
        try {
          applyAwarenessUpdate(awareness, base64ToBytes(row.state), "remote");
        } catch (error) {
          reportAsync(error);
        }
      }
    }
    const staleClientIds: number[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      const remoteSession = state.user?.sessionId;
      if (
        clientId !== awareness.clientID &&
        typeof remoteSession === "string" &&
        !activeSessions.has(remoteSession)
      ) {
        staleClientIds.push(clientId);
      }
    }
    if (staleClientIds.length > 0) {
      removeAwarenessStates(awareness, staleClientIds, "stale");
    }
  }, [engine, presenceResult, sessionId]);

  useEffect(() => {
    if (!engine || !documentId || !sessionId) {
      return;
    }
    const { awareness } = engine;
    const send = () => {
      if (!navigator.onLine) return;
      const state = encodeAwarenessUpdate(awareness, [awareness.clientID]);
      void heartbeat({
        documentId: documentId as Id<"documents">,
        sessionId,
        name: user.name,
        email: user.email,
        color: userColor.color,
        image: user.image,
        state: bytesToBase64(state),
      })
        .then((result) => {
          if (result && !result.ok && result.error !== "rate-limited") {
            reportAsync(new Error(result.error));
          }
        })
        .catch(reportAsync);
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        send();
      }, 300);
    };
    const onPageHide = () => beaconLeave(documentId, sessionId);
    const onOnline = () => send();
    awareness.on("update", onChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);
    send();
    const interval = setInterval(send, HEARTBEAT_MS);
    return () => {
      awareness.off("update", onChange);
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      clearInterval(interval);
      beaconLeave(documentId, sessionId);
      void leavePresence({
        documentId: documentId as Id<"documents">,
        sessionId,
      }).catch(reportAsync);
    };
  }, [
    engine,
    documentId,
    heartbeat,
    leavePresence,
    user.name,
    user.email,
    user.image,
    userColor,
    sessionId,
  ]);

  const viewers = useMemo<CollabViewer[]>(() => {
    const byUser = new Map<string, CollabViewer>();
    for (const row of presenceResult ?? []) {
      const isSelf = row.sessionId === sessionId;
      const current = byUser.get(row.userId);
      if (!current || (isSelf && !current.isSelf)) {
        byUser.set(row.userId, {
          sessionId: row.sessionId,
          userId: row.userId,
          name: row.name,
          email: row.email,
          color: row.color,
          image: row.image,
          role: row.role,
          isSelf,
        });
      }
    }
    return [...byUser.values()].sort((a, b) => (a.isSelf === b.isSelf ? 0 : a.isSelf ? -1 : 1));
  }, [presenceResult, sessionId]);
  if (!engine) {
    return null;
  }
  return {
    ydoc: engine.ydoc,
    ytext: engine.ytext,
    awareness: engine.awareness,
    ready,
    online,
    offlineAvailable,
    storageDegraded,
    syncing,
    blocked,
    pendingEdits,
    lastSyncedAt,
    viewers,
    sessionId,
    userLabel,
    color: userColor.color,
    colorLight: userColor.light,
    seq,
  };
}
