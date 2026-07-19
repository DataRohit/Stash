import type { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";

const DATABASE_PREFIX = "stash-offline-v1:";
const REGISTRY_KEY = "stash:offline-document-registry:v1";
const VALID_CACHE_KEY = "stash-valid-cache";
const MAX_RECENT_DOCUMENTS = 20;
const MAX_REGISTRY_ENTRIES = 500;
const OPEN_TIMEOUT_MS = 8_000;
const CLEAR_CHANNEL = "stash-offline-clear-v1";

type RegistryEntry = {
  name: string;
  organizationId: string;
  userId: string;
  documentId: string;
  openedAt: number;
};

export type OfflineDocumentIdentity = {
  organizationId: string;
  userId: string;
  documentId: string;
};

export type OfflineDocumentHandle = {
  identity: OfflineDocumentIdentity;
  name: string;
  provider: IndexeddbPersistence;
  available: boolean;
};

type ClearFilter = Partial<
  Pick<OfflineDocumentIdentity, "organizationId" | "userId" | "documentId">
>;

function databaseName(identity: OfflineDocumentIdentity): string {
  return `${DATABASE_PREFIX}${identity.organizationId}:${identity.userId}:${identity.documentId}`;
}

function validEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RegistryEntry>;
  return (
    typeof entry.name === "string" &&
    entry.name.startsWith(DATABASE_PREFIX) &&
    typeof entry.organizationId === "string" &&
    typeof entry.userId === "string" &&
    typeof entry.documentId === "string" &&
    typeof entry.openedAt === "number" &&
    Number.isFinite(entry.openedAt)
  );
}

function readRegistry(): RegistryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validEntry).slice(0, MAX_REGISTRY_ENTRIES);
  } catch {
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(REGISTRY_KEY);
    else localStorage.setItem(REGISTRY_KEY, JSON.stringify(entries.slice(0, MAX_REGISTRY_ENTRIES)));
  } catch {}
}

function matches(entry: RegistryEntry, filter: ClearFilter): boolean {
  return (
    (!filter.organizationId || entry.organizationId === filter.organizationId) &&
    (!filter.userId || entry.userId === filter.userId) &&
    (!filter.documentId || entry.documentId === filter.documentId)
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("offline-storage-timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function orphanedDatabaseNames(filter: ClearFilter): Promise<string[]> {
  if (!("databases" in indexedDB)) return [];
  try {
    const databases = await indexedDB.databases();
    const prefix = `${DATABASE_PREFIX}${filter.organizationId ?? ""}`;
    return databases
      .map((database) => database.name)
      .filter((name): name is string => {
        if (!name?.startsWith(prefix)) return false;
        const identity = name.slice(DATABASE_PREFIX.length).split(":");
        const [organizationId, userId, documentId] = identity;
        return (
          (!filter.organizationId || organizationId === filter.organizationId) &&
          (!filter.userId || userId === filter.userId) &&
          (!filter.documentId || documentId === filter.documentId)
        );
      });
  } catch {
    return [];
  }
}

async function deleteDatabases(names: string[]): Promise<void> {
  const { clearDocument } = await import("y-indexeddb");
  const results = await Promise.allSettled(
    [...new Set(names)].map((name) => withTimeout(clearDocument(name), OPEN_TIMEOUT_MS)),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("offline-storage-clear-failed");
  }
}

function broadcastClear(filter: ClearFilter): void {
  try {
    const channel = new BroadcastChannel(CLEAR_CHANNEL);
    channel.postMessage(filter);
    channel.close();
  } catch {}
}

async function trimRegistry(current: RegistryEntry): Promise<void> {
  const entries = readRegistry().filter((entry) => entry.name !== current.name);
  entries.unshift(current);
  const sameWorkspace = entries
    .filter(
      (entry) => entry.organizationId === current.organizationId && entry.userId === current.userId,
    )
    .sort((left, right) => right.openedAt - left.openedAt);
  const evicted = sameWorkspace.slice(MAX_RECENT_DOCUMENTS);
  const evictedNames = new Set(evicted.map((entry) => entry.name));
  if (evictedNames.size > 0) {
    evicted.forEach((entry) => {
      broadcastClear({
        organizationId: entry.organizationId,
        userId: entry.userId,
        documentId: entry.documentId,
      });
    });
    await deleteDatabases([...evictedNames]);
  }
  writeRegistry(entries.filter((entry) => !evictedNames.has(entry.name)));
}

export async function openOfflineDocument(
  identity: OfflineDocumentIdentity,
  ydoc: Y.Doc,
): Promise<OfflineDocumentHandle> {
  const { IndexeddbPersistence } = await import("y-indexeddb");
  const name = databaseName(identity);
  const provider = new IndexeddbPersistence(name, ydoc);
  try {
    await withTimeout(provider.whenSynced, OPEN_TIMEOUT_MS);
    const available = (await provider.get(VALID_CACHE_KEY)) === 1;
    if (available) {
      await trimRegistry({ ...identity, name, openedAt: Date.now() });
    }
    return { identity, name, provider, available };
  } catch (error) {
    await withTimeout(provider.destroy(), OPEN_TIMEOUT_MS).catch(() => undefined);
    throw error;
  }
}

export async function markOfflineDocumentAvailable(handle: OfflineDocumentHandle): Promise<void> {
  await handle.provider.set(VALID_CACHE_KEY, 1);
  handle.available = true;
  await trimRegistry({ ...handle.identity, name: handle.name, openedAt: Date.now() });
}

export async function closeOfflineDocument(handle: OfflineDocumentHandle): Promise<void> {
  await withTimeout(handle.provider.destroy(), OPEN_TIMEOUT_MS);
}

export async function clearOfflineDocument(handle: OfflineDocumentHandle): Promise<void> {
  await withTimeout(handle.provider.clearData(), OPEN_TIMEOUT_MS);
  writeRegistry(readRegistry().filter((entry) => entry.name !== handle.name));
}

export async function clearOfflineDocuments(filter: ClearFilter): Promise<void> {
  const registry = readRegistry();
  const matched = registry.filter((entry) => matches(entry, filter));
  const orphaned = await orphanedDatabaseNames(filter);
  broadcastClear(filter);
  await deleteDatabases([...matched.map((entry) => entry.name), ...orphaned]);
  writeRegistry(registry.filter((entry) => !matches(entry, filter)));
}

export function subscribeToOfflineClear(
  identity: OfflineDocumentIdentity,
  clear: () => void,
): () => void {
  try {
    const channel = new BroadcastChannel(CLEAR_CHANNEL);
    channel.addEventListener("message", (event: MessageEvent<ClearFilter>) => {
      if (
        event.data &&
        (!event.data.organizationId || event.data.organizationId === identity.organizationId) &&
        (!event.data.userId || event.data.userId === identity.userId) &&
        (!event.data.documentId || event.data.documentId === identity.documentId)
      ) {
        clear();
      }
    });
    return () => channel.close();
  } catch {
    return () => undefined;
  }
}
