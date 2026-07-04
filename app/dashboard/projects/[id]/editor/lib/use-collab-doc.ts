"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const CURSOR_COLORS = [
  { color: "#ef4444", light: "#ef444433" },
  { color: "#2563eb", light: "#2563eb33" },
  { color: "#16a34a", light: "#16a34a33" },
  { color: "#9333ea", light: "#9333ea33" },
  { color: "#db2777", light: "#db277733" },
  { color: "#0891b2", light: "#0891b233" },
  { color: "#ca8a04", light: "#ca8a0433" },
  { color: "#dc2626", light: "#dc262633" },
  { color: "#4f46e5", light: "#4f46e533" },
  { color: "#059669", light: "#05966933" },
  { color: "#c026d3", light: "#c026d333" },
  { color: "#ea580c", light: "#ea580c33" },
  { color: "#0284c7", light: "#0284c733" },
  { color: "#65a30d", light: "#65a30d33" },
  { color: "#7c3aed", light: "#7c3aed33" },
  { color: "#be123c", light: "#be123c33" },
  { color: "#0d9488", light: "#0d948833" },
  { color: "#a16207", light: "#a1620733" },
];
const DEFAULT_CURSOR_COLOR = { color: "#2563eb", light: "#2563eb33" };

const FLUSH_MS = 200;
const HEARTBEAT_MS = 10_000;

export type CollabViewer = {
  sessionId: string;
  userId: string;
  name: string;
  email: string | null;
  color: string;
  image: string | null;
  isSelf: boolean;
};

type CollabUser = { id: string; name: string; email: string | null; image: string | null };

type Engine = { ydoc: Y.Doc; ytext: Y.Text; awareness: Awareness };
type CursorColor = (typeof CURSOR_COLORS)[number];

type CollabDoc = {
  ytext: Y.Text;
  awareness: Awareness;
  ready: boolean;
  viewers: CollabViewer[];
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

export function useCollabDoc(
  documentId: string | null,
  canEdit: boolean,
  user: CollabUser,
): CollabDoc | null {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [ready, setReady] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const pullResult = useQuery(
    api.collab.pullUpdates,
    documentId ? { documentId: documentId as Id<"documents">, afterSeq: 0 } : "skip",
  );
  const presenceResult = useQuery(
    api.presence.list,
    documentId ? { documentId: documentId as Id<"documents"> } : "skip",
  );
  const pushUpdate = useMutation(api.collab.pushUpdate);
  const ensureSeed = useMutation(api.collab.ensureSeed);
  const saveSnapshot = useMutation(api.collab.saveSnapshot);
  const heartbeat = useMutation(api.presence.heartbeat);
  const leavePresence = useMutation(api.presence.leave);

  const appliedSeq = useRef(0);
  const seeded = useRef(false);
  const userColor = useMemo(() => colorForUser(user.id), [user.id]);
  const userLabel = useMemo(
    () => (user.email ? `${user.name} · ${user.email}` : user.name),
    [user.name, user.email],
  );

  useEffect(() => {
    setSessionId(createSessionId());
  }, []);

  useEffect(() => {
    if (!documentId || !sessionId) {
      setEngine(null);
      setReady(false);
      return;
    }
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("codemirror");
    const awareness = new Awareness(ydoc);
    appliedSeq.current = 0;
    seeded.current = false;
    setReady(false);
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
    });
  }, [engine, userLabel, userColor]);

  useEffect(() => {
    if (!engine || !documentId || !canEdit) {
      return;
    }
    const { ydoc } = engine;
    let pending: Uint8Array[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = async () => {
      timer = null;
      if (pending.length === 0) {
        return;
      }
      const merged = Y.mergeUpdates(pending);
      pending = [];
      const result = await pushUpdate({
        documentId: documentId as Id<"documents">,
        update: toArrayBuffer(merged),
      });
      if (result.shouldCompact) {
        await saveSnapshot({
          documentId: documentId as Id<"documents">,
          snapshot: toArrayBuffer(Y.encodeStateAsUpdate(ydoc)),
          throughSeq: appliedSeq.current,
        });
      }
    };
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || origin === "seed") {
        return;
      }
      pending.push(update);
      if (timer === null) {
        timer = setTimeout(() => void flush(), FLUSH_MS);
      }
    };
    ydoc.on("update", onUpdate);
    return () => {
      ydoc.off("update", onUpdate);
      if (timer !== null) {
        clearTimeout(timer);
      }
      void flush();
    };
  }, [engine, documentId, canEdit, pushUpdate, saveSnapshot]);

  useEffect(() => {
    if (!engine || !documentId || pullResult === undefined) {
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
    if (isEmpty && canEdit && !seeded.current) {
      seeded.current = true;
      void ensureSeed({ documentId: documentId as Id<"documents"> });
    }
  }, [engine, documentId, pullResult, canEdit, ensureSeed]);

  useEffect(() => {
    if (!engine || !presenceResult) {
      return;
    }
    const { awareness } = engine;
    for (const row of presenceResult) {
      if (row.sessionId !== sessionId && row.state.length > 0) {
        applyAwarenessUpdate(awareness, base64ToBytes(row.state), "remote");
      }
    }
  }, [engine, presenceResult, sessionId]);

  useEffect(() => {
    if (!engine || !documentId || !sessionId) {
      return;
    }
    const { awareness } = engine;
    const send = () => {
      const state = encodeAwarenessUpdate(awareness, [awareness.clientID]);
      void heartbeat({
        documentId: documentId as Id<"documents">,
        sessionId,
        name: user.name,
        email: user.email,
        color: userColor.color,
        image: user.image,
        state: bytesToBase64(state),
      }).catch(reportAsync);
    };
    const onChange = () => send();
    awareness.on("update", onChange);
    send();
    const interval = setInterval(send, HEARTBEAT_MS);
    return () => {
      awareness.off("update", onChange);
      clearInterval(interval);
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
    const rows = (presenceResult ?? []).map((row) => ({
      sessionId: row.sessionId,
      userId: row.userId,
      name: row.name,
      email: row.email,
      color: row.color,
      image: row.image,
      isSelf: row.sessionId === sessionId,
    }));
    rows.sort((a, b) => (a.isSelf === b.isSelf ? 0 : a.isSelf ? -1 : 1));
    return rows;
  }, [presenceResult, sessionId]);
  if (!engine) {
    return null;
  }
  return { ytext: engine.ytext, awareness: engine.awareness, ready, viewers };
}
