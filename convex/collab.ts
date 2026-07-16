import { v } from "convex/values";
import * as Y from "yjs";
import {
  BoardValidationError,
  getBoardRoots,
  inspectBoard,
  MAX_BOARD_STORED_BYTES,
  seedBoard,
  UNFILED_COLUMN_ID,
} from "../lib/board-model";
import { resolveChartData } from "../lib/chart-data";
import {
  ChartValidationError,
  inspectChart,
  MAX_CHART_STORED_BYTES,
  replaceChartState,
  seedChart,
} from "../lib/chart-model";
import {
  boardRenderModel,
  chartRenderModel,
  chartSourceFromSheet,
  documentSize,
  project,
  sheetRenderModel,
  viewRenderModel,
} from "../lib/doc-projection";
import type { FileType } from "../lib/document-types";
import {
  getSheetRoots,
  inspectSheet,
  MAX_SHEET_STORED_BYTES,
  SheetValidationError,
  seedSheet,
} from "../lib/sheet-model";
import {
  inspectView,
  MAX_VIEW_STORED_BYTES,
  replaceViewState,
  seedView,
  ViewValidationError,
} from "../lib/view-model";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordProjectEvent } from "./activity";
import {
  accessForProject,
  addProjectBytes,
  byteLength,
  cachedProjectBytes,
  isInactiveTree,
  maxProjectBytes,
  requireProjectAdmin,
  requireProjectEditor,
} from "./documents";
import {
  clampInt,
  DEFAULT_HISTORY_RETENTION_DAYS,
  HARD_MAX_HISTORY_RETENTION_DAYS,
  MIN_HISTORY_RETENTION_DAYS,
} from "./limits";
import { enforceWriteRateLimit } from "./writeRateLimit";

const COMPACT_THRESHOLD = 200;
const COMPACT_OVERLAP = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_PER_DOC = 50;
const HISTORY_PRUNE_BATCH = 50;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_COLLAB_UPDATE_BYTES = 768 * 1024;
const STRUCTURED_REPLACE_CHUNK_BYTES = 192 * 1024;
const STRUCTURED_REPLACE_CHUNK_ITEMS = 512;
const COLLAB_WRITE_LIMIT = { capacity: 30, refillPerSecond: 5 };

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function docFileType(doc: Doc<"documents">): FileType {
  if (
    doc.fileType === "md" ||
    doc.fileType === "html" ||
    doc.fileType === "sheet" ||
    doc.fileType === "board" ||
    doc.fileType === "view" ||
    doc.fileType === "chart"
  ) {
    return doc.fileType;
  }
  throw new Error("invalid-type");
}

async function documentProject(
  ctx: QueryCtx,
  documentId: Id<"documents">,
): Promise<Id<"projects"> | null> {
  const doc = await ctx.db.get(documentId);
  if (doc?.kind !== "file") {
    return null;
  }
  return doc.projectId;
}

async function latestSeq(ctx: QueryCtx, documentId: Id<"documents">): Promise<number> {
  const latest = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .order("desc")
    .first();
  return latest?.seq ?? 0;
}

async function allocateSeq(ctx: MutationCtx, documentId: Id<"documents">): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const seq = (await latestSeq(ctx, documentId)) + 1;
    const clash = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", documentId).eq("seq", seq))
      .unique();
    if (!clash) {
      return seq;
    }
  }
  throw new Error("seq-conflict");
}

async function baseSnapshot(ctx: QueryCtx, documentId: Id<"documents">) {
  const [base, legacy] = await Promise.all([
    ctx.db
      .query("yjsSnapshots")
      .withIndex("by_document_purpose", (q) => q.eq("documentId", documentId).eq("purpose", "base"))
      .order("desc")
      .first(),
    ctx.db
      .query("yjsSnapshots")
      .withIndex("by_document_purpose", (q) =>
        q.eq("documentId", documentId).eq("purpose", undefined),
      )
      .order("desc")
      .first(),
  ]);
  if (!base) {
    return legacy;
  }
  if (!legacy) {
    return base;
  }
  return base.throughSeq >= legacy.throughSeq ? base : legacy;
}

async function historyRows(ctx: QueryCtx, documentId: Id<"documents">) {
  return await ctx.db
    .query("yjsSnapshots")
    .withIndex("by_document_purpose_created", (q) =>
      q.eq("documentId", documentId).eq("purpose", "history"),
    )
    .order("desc")
    .take(MAX_HISTORY_PER_DOC + HISTORY_PRUNE_BATCH);
}

async function materializedContent(
  ctx: QueryCtx,
  doc: Doc<"documents">,
  pendingUpdate: ArrayBuffer,
): Promise<{
  content: string;
  state: ArrayBuffer;
  replayed: number;
  size: number;
  sheetMeta?: { rows: number; cols: number };
  boardMeta?: { columns: number; cards: number };
  cleanupUpdate?: ArrayBuffer;
} | null> {
  const ydoc = new Y.Doc();
  let baseSeq = doc.contentSeq ?? 0;
  if (doc.contentState) {
    Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
  } else {
    const snapshot = await baseSnapshot(ctx, doc._id);
    if (snapshot) {
      Y.applyUpdate(ydoc, new Uint8Array(snapshot.snapshot));
    }
    baseSeq = snapshot?.throughSeq ?? 0;
  }
  const updates = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", doc._id).gt("seq", baseSeq))
    .collect();
  for (const row of updates) {
    Y.applyUpdate(ydoc, new Uint8Array(row.update));
  }
  const fileType = docFileType(doc);
  const cleanupCells = new Set<string>();
  const cleanupColMeta = new Set<string>();
  const cleanupRowMeta = new Set<string>();
  const duplicateRows = new Set<string>();
  const duplicateCols = new Set<string>();
  const boardOrderCleanup = new Set<string>();
  const boardMetaCleanup = new Set<string>();
  const priorBoardAssignees = new Set<string>();
  const priorBoardLinks = new Set<string>();
  const priorBoardLabels = new Set<string>();
  const duplicateBoardColumns = new Set<string>();
  let priorChartSource: string | null = null;
  if (fileType === "sheet") {
    const inspection = inspectSheet(ydoc);
    const roots = getSheetRoots(ydoc);
    const activeKeys = new Set<string>();
    for (const rowId of inspection.rows) {
      for (const colId of inspection.cols) activeKeys.add(`${rowId}:${colId}`);
    }
    for (const key of roots.cells.keys()) {
      if (!activeKeys.has(key)) cleanupCells.add(key);
    }
    for (const id of roots.colMeta.keys()) {
      if (!inspection.colSet.has(id)) cleanupColMeta.add(id);
    }
    for (const id of roots.rowMeta.keys()) {
      if (!inspection.rowSet.has(id)) cleanupRowMeta.add(id);
    }
    const seenRows = new Set<string>();
    for (const rowId of roots.rows.toArray()) {
      if (seenRows.has(rowId)) duplicateRows.add(rowId);
      seenRows.add(rowId);
    }
    const seenCols = new Set<string>();
    for (const colId of roots.cols.toArray()) {
      if (seenCols.has(colId)) duplicateCols.add(colId);
      seenCols.add(colId);
    }
  }
  if (fileType === "board") {
    const inspection = inspectBoard(ydoc);
    const roots = getBoardRoots(ydoc);
    for (const card of inspection.cards.values()) {
      for (const userId of card.assignees) priorBoardAssignees.add(userId);
      for (const labelId of card.labels) priorBoardLabels.add(labelId);
      if (card.linkedDocId) priorBoardLinks.add(card.linkedDocId);
    }
    const seenColumns = new Set<string>();
    for (const columnId of roots.columns.toArray()) {
      if (seenColumns.has(columnId)) duplicateBoardColumns.add(columnId);
      seenColumns.add(columnId);
    }
    for (const id of roots.columnMeta.keys()) {
      if (!inspection.columnSet.has(id)) boardMetaCleanup.add(id);
    }
    for (const [columnId, order] of roots.cardOrder.entries()) {
      if (columnId !== UNFILED_COLUMN_ID && !inspection.columnSet.has(columnId)) {
        boardOrderCleanup.add(columnId);
        continue;
      }
      const seen = new Set<string>();
      for (const cardId of order.toArray()) {
        const card = inspection.cards.get(cardId);
        if (!card || card.columnId !== columnId || seen.has(cardId))
          boardOrderCleanup.add(columnId);
        seen.add(cardId);
      }
    }
  }
  if (fileType === "chart") {
    priorChartSource = inspectChart(ydoc).sourceDocId;
  }
  try {
    Y.applyUpdate(ydoc, new Uint8Array(pendingUpdate));
  } catch {
    ydoc.destroy();
    return null;
  }
  let cleanupUpdate: ArrayBuffer | undefined;
  if (
    fileType === "sheet" &&
    (cleanupCells.size > 0 ||
      cleanupColMeta.size > 0 ||
      cleanupRowMeta.size > 0 ||
      duplicateRows.size > 0 ||
      duplicateCols.size > 0)
  ) {
    const roots = getSheetRoots(ydoc);
    const vector = Y.encodeStateVector(ydoc);
    let changed = false;
    ydoc.transact(() => {
      for (const key of cleanupCells) {
        if (roots.cells.has(key)) {
          roots.cells.delete(key);
          changed = true;
        }
      }
      for (const id of cleanupColMeta) {
        if (roots.colMeta.has(id)) {
          roots.colMeta.delete(id);
          changed = true;
        }
      }
      for (const id of cleanupRowMeta) {
        if (roots.rowMeta.has(id)) {
          roots.rowMeta.delete(id);
          changed = true;
        }
      }
      for (const [array, duplicates] of [
        [roots.rows, duplicateRows],
        [roots.cols, duplicateCols],
      ] as const) {
        const seen = new Set<string>();
        for (let index = 0; index < array.length; ) {
          const current = array.get(index);
          if (duplicates.has(current) && seen.has(current)) {
            array.delete(index, 1);
            changed = true;
          } else {
            seen.add(current);
            index += 1;
          }
        }
      }
    }, "cleanup");
    if (changed) cleanupUpdate = toArrayBuffer(Y.encodeStateAsUpdate(ydoc, vector));
  }
  if (
    fileType === "board" &&
    (boardOrderCleanup.size > 0 || boardMetaCleanup.size > 0 || duplicateBoardColumns.size > 0)
  ) {
    const roots = getBoardRoots(ydoc);
    const inspection = inspectBoard(ydoc);
    const vector = Y.encodeStateVector(ydoc);
    let changed = false;
    ydoc.transact(() => {
      for (const id of boardMetaCleanup) {
        if (roots.columnMeta.has(id)) {
          roots.columnMeta.delete(id);
          changed = true;
        }
      }
      const seenColumns = new Set<string>();
      for (let index = 0; index < roots.columns.length; ) {
        const columnId = roots.columns.get(index);
        if (duplicateBoardColumns.has(columnId) && seenColumns.has(columnId)) {
          roots.columns.delete(index, 1);
          changed = true;
        } else {
          seenColumns.add(columnId);
          index += 1;
        }
      }
      for (const columnId of boardOrderCleanup) {
        const order = roots.cardOrder.get(columnId);
        if (!order) continue;
        if (columnId !== UNFILED_COLUMN_ID && !inspection.columnSet.has(columnId)) {
          roots.cardOrder.delete(columnId);
          changed = true;
          continue;
        }
        const seen = new Set<string>();
        for (let index = 0; index < order.length; ) {
          const cardId = order.get(index);
          const card = inspection.cards.get(cardId);
          if (!card || card.columnId !== columnId || seen.has(cardId)) {
            order.delete(index, 1);
            changed = true;
          } else {
            seen.add(cardId);
            index += 1;
          }
        }
      }
      let unfiled = roots.cardOrder.get(UNFILED_COLUMN_ID);
      if (!unfiled) {
        unfiled = new Y.Array<string>();
        roots.cardOrder.set(UNFILED_COLUMN_ID, unfiled);
        changed = true;
      }
      for (const card of inspection.cards.values()) {
        if (card.columnId !== UNFILED_COLUMN_ID && !inspection.columnSet.has(card.columnId)) {
          const cardMap = roots.cards.get(card.id);
          cardMap?.set("columnId", UNFILED_COLUMN_ID);
          if (!unfiled.toArray().includes(card.id)) unfiled.push([card.id]);
          changed = true;
        }
      }
    }, "cleanup");
    if (changed) cleanupUpdate = toArrayBuffer(Y.encodeStateAsUpdate(ydoc, vector));
  }
  const sheetInspection = fileType === "sheet" ? inspectSheet(ydoc) : null;
  const boardInspection = fileType === "board" ? inspectBoard(ydoc) : null;
  if (fileType === "view") inspectView(ydoc);
  if (fileType === "chart") {
    const config = inspectChart(ydoc);
    if (config.sourceDocId && config.sourceDocId !== priorChartSource) {
      const id = ctx.db.normalizeId("documents", config.sourceDocId);
      const source = id ? await ctx.db.get(id) : null;
      if (
        !source ||
        source.projectId !== doc.projectId ||
        source.kind !== "file" ||
        source.fileType !== "sheet" ||
        source.trashedAt ||
        source.deletingAt
      ) {
        throw new ChartValidationError();
      }
    }
  }
  if (boardInspection) {
    const roots = getBoardRoots(ydoc);
    const assignees = new Set<string>();
    const linkedDocuments = new Set<string>();
    for (const card of boardInspection.cards.values()) {
      for (const userId of card.assignees) assignees.add(userId);
      for (const labelId of card.labels) {
        if (!roots.labelMeta.has(labelId) && !priorBoardLabels.has(labelId)) {
          throw new BoardValidationError("invalid-update");
        }
      }
      if (card.linkedDocId) linkedDocuments.add(card.linkedDocId);
    }
    for (const userId of assignees) {
      if (priorBoardAssignees.has(userId)) continue;
      const member = await ctx.db
        .query("members")
        .withIndex("by_org_user", (q) =>
          q.eq("clerkOrgId", doc.clerkOrgId).eq("memberUserId", userId),
        )
        .unique();
      if (member?.status !== "accepted") {
        throw new BoardValidationError("invalid-update");
      }
    }
    for (const documentId of linkedDocuments) {
      if (priorBoardLinks.has(documentId)) continue;
      const id = ctx.db.normalizeId("documents", documentId);
      const linked = id ? await ctx.db.get(id) : null;
      if (
        !linked ||
        linked.projectId !== doc.projectId ||
        linked.kind !== "file" ||
        linked.trashedAt ||
        linked.deletingAt
      ) {
        throw new BoardValidationError("invalid-update");
      }
    }
  }
  const content = project(fileType, ydoc);
  const state = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
  const size = documentSize(fileType, ydoc);
  ydoc.destroy();
  return {
    content,
    state,
    replayed: updates.length,
    size,
    ...(sheetInspection ? { sheetMeta: sheetInspection.dimensions } : {}),
    ...(boardInspection ? { boardMeta: boardInspection.dimensions } : {}),
    cleanupUpdate,
  };
}

async function materializedState(ctx: QueryCtx, doc: Doc<"documents">): Promise<ArrayBuffer> {
  if (doc.contentState) {
    return doc.contentState;
  }
  const ydoc = new Y.Doc();
  const snapshot = await baseSnapshot(ctx, doc._id);
  if (snapshot) {
    Y.applyUpdate(ydoc, new Uint8Array(snapshot.snapshot));
  }
  const baseSeq = snapshot?.throughSeq ?? 0;
  const updates = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", doc._id).gt("seq", baseSeq))
    .collect();
  for (const row of updates) {
    Y.applyUpdate(ydoc, new Uint8Array(row.update));
  }
  const state = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();
  return state;
}

async function syncBoardLinkIndex(
  ctx: MutationCtx,
  doc: Doc<"documents">,
  state: ArrayBuffer,
  userId: string,
): Promise<void> {
  if (doc.fileType !== "board") return;
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(state));
  const render = boardRenderModel(ydoc);
  const desired = new Map<string, string>();
  for (const card of inspectBoard(ydoc).cards.values()) {
    if (card.linkedDocId) desired.set(card.id, card.linkedDocId);
  }
  const desiredCards = new Map(
    render.columns.flatMap((column) =>
      column.cards.map(
        (card) =>
          [
            card.id,
            { title: card.title, columnName: column.name, due: card.due ?? undefined },
          ] as const,
      ),
    ),
  );
  ydoc.destroy();
  const existing = (
    await ctx.db
      .query("documentLinks")
      .withIndex("by_source_document", (q) => q.eq("sourceDocumentId", doc._id))
      .collect()
  ).filter((link) => link.managedByBoard !== false);
  const now = Date.now();
  for (const link of existing) {
    const target = link.sourceCardId ? desired.get(link.sourceCardId) : undefined;
    if (!target || target !== link.targetDocumentId) await ctx.db.delete(link._id);
    else desired.delete(link.sourceCardId ?? "");
  }
  for (const [sourceCardId, target] of desired) {
    const targetDocumentId = ctx.db.normalizeId("documents", target);
    const targetDocument = targetDocumentId ? await ctx.db.get(targetDocumentId) : null;
    if (!targetDocument || targetDocument.projectId !== doc.projectId) continue;
    await ctx.db.insert("documentLinks", {
      clerkOrgId: doc.clerkOrgId,
      sourceProjectId: doc.projectId,
      sourceDocumentId: doc._id,
      sourceCardId,
      managedByBoard: true,
      targetProjectId: targetDocument.projectId,
      targetDocumentId: targetDocument._id,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  }
  const existingCards = await ctx.db
    .query("boardCardRecords")
    .withIndex("by_document", (q) => q.eq("documentId", doc._id))
    .collect();
  for (const row of existingCards) {
    const card = desiredCards.get(row.cardId);
    if (!card) {
      await ctx.db.delete(row._id);
      continue;
    }
    if (row.title !== card.title || row.columnName !== card.columnName || row.due !== card.due) {
      await ctx.db.patch(row._id, { ...card, updatedAt: now });
    }
    desiredCards.delete(row.cardId);
  }
  for (const [cardId, card] of desiredCards) {
    await ctx.db.insert("boardCardRecords", {
      clerkOrgId: doc.clerkOrgId,
      projectId: doc.projectId,
      documentId: doc._id,
      cardId,
      ...card,
      updatedAt: now,
    });
  }
}

export const rebuildBoardIndexes = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || doc.fileType !== "board" || !doc.contentState) return;
    await syncBoardLinkIndex(ctx, doc, doc.contentState, "system");
  },
});

export const backfillProjectBoardIndexes = internalMutation({
  args: { projectId: v.id("projects"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("documents")
      .withIndex("by_project_kind", (q) => q.eq("projectId", args.projectId).eq("kind", "file"))
      .paginate({ numItems: 50, cursor: args.cursor ?? null });
    for (const doc of page.page) {
      if (doc.fileType === "board") {
        await ctx.scheduler.runAfter(0, internal.collab.rebuildBoardIndexes, {
          documentId: doc._id,
        });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.collab.backfillProjectBoardIndexes, {
        projectId: args.projectId,
        cursor: page.continueCursor,
      });
    }
  },
});

function contentFromState(state: ArrayBuffer, fileType: FileType): string {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(state));
  const content = project(fileType, ydoc);
  ydoc.destroy();
  return content;
}

function sheetPreviewFromState(state: ArrayBuffer) {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(state));
  const preview = sheetRenderModel(ydoc);
  ydoc.destroy();
  return preview;
}

function boardPreviewFromState(state: ArrayBuffer) {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(state));
  const preview = boardRenderModel(ydoc);
  ydoc.destroy();
  return preview;
}

function viewPreviewFromState(state: ArrayBuffer) {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(state));
  const preview = viewRenderModel(ydoc);
  ydoc.destroy();
  return preview;
}

async function chartSourceForConfig(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  sourceDocId: string | null,
) {
  if (!sourceDocId) return null;
  const id = ctx.db.normalizeId("documents", sourceDocId);
  const source = id ? await ctx.db.get(id) : null;
  if (
    source?.kind !== "file" ||
    source.projectId !== projectId ||
    source.fileType !== "sheet" ||
    !source.contentState ||
    (await isInactiveTree(ctx, source))
  ) {
    return null;
  }
  const sheet = new Y.Doc();
  Y.applyUpdate(sheet, new Uint8Array(source.contentState));
  const result = chartSourceFromSheet(sheet, source._id, source.name);
  sheet.destroy();
  return result;
}

async function chartPreviewFromState(ctx: QueryCtx, doc: Doc<"documents">, state: ArrayBuffer) {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(state));
  const config = chartRenderModel(ydoc);
  ydoc.destroy();
  const source = await chartSourceForConfig(ctx, doc.projectId, config.sourceDocId);
  return resolveChartData(config, source);
}

function copyYMap(source: Y.Map<unknown>): Y.Map<unknown> {
  const target = new Y.Map<unknown>();
  for (const [key, value] of source.entries()) target.set(key, value);
  return target;
}

function copyBoardMap(source: Y.Map<unknown>): Y.Map<unknown> {
  const target = new Y.Map<unknown>();
  for (const [key, value] of source.entries()) {
    if (value instanceof Y.Text) {
      const text = new Y.Text();
      if (value.length > 0) text.insert(0, value.toString());
      target.set(key, text);
    } else if (value instanceof Y.Array) {
      const array = new Y.Array<unknown>();
      if (value.length > 0) array.insert(0, value.toArray());
      target.set(key, array);
    } else {
      target.set(key, value);
    }
  }
  return target;
}

function estimatedValueBytes(value: unknown): number {
  if (typeof value === "string") return byteLength(value);
  if (value instanceof Y.Text) return byteLength(value.toString()) + 64;
  if (value instanceof Y.Array) {
    return value.toArray().reduce((size, item) => size + estimatedValueBytes(item) + 16, 64);
  }
  return 16;
}

function estimatedMapEntryBytes(key: string, value: Y.Map<unknown>): number {
  let size = byteLength(key) + 192;
  for (const [field, fieldValue] of value.entries()) {
    size += byteLength(field) + estimatedValueBytes(fieldValue) + 32;
  }
  return size;
}

function chunkValues<T>(values: readonly T[], estimate: (value: T) => number): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let bytes = 0;
  for (const value of values) {
    const valueBytes = Math.max(1, estimate(value));
    if (
      chunk.length > 0 &&
      (chunk.length >= STRUCTURED_REPLACE_CHUNK_ITEMS ||
        bytes + valueBytes > STRUCTURED_REPLACE_CHUNK_BYTES)
    ) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(value);
    bytes += valueBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function replaceSheetStateInChunks(
  current: Y.Doc,
  target: Y.Doc,
  origin: "import" | "restore",
): ArrayBuffer[] {
  const currentRoots = getSheetRoots(current);
  const targetRoots = getSheetRoots(target);
  const updates: ArrayBuffer[] = [];
  const transact = (apply: () => void) => {
    const vector = Y.encodeStateVector(current);
    current.transact(apply, origin);
    const update = Y.encodeStateAsUpdate(current, vector);
    if (update.byteLength === 0) return;
    if (update.byteLength > MAX_COLLAB_UPDATE_BYTES) throw new Error("update-too-large");
    updates.push(toArrayBuffer(update));
  };
  const clearMap = <T>(map: Y.Map<T>) => {
    for (const chunk of chunkValues([...map.keys()], (key) => byteLength(key) + 64)) {
      transact(() => {
        for (const key of chunk) map.delete(key);
      });
    }
  };
  for (const array of [currentRoots.rows, currentRoots.cols]) {
    while (array.length > 0) {
      transact(() => array.delete(0, Math.min(array.length, 2048)));
    }
  }
  clearMap(currentRoots.cells);
  clearMap(currentRoots.colMeta);
  clearMap(currentRoots.rowMeta);
  for (const [array, values] of [
    [currentRoots.rows, targetRoots.rows.toArray()],
    [currentRoots.cols, targetRoots.cols.toArray()],
  ] as const) {
    for (const chunk of chunkValues(values, (value) => byteLength(value) + 32)) {
      transact(() => array.insert(array.length, chunk));
    }
  }
  for (const [currentMap, entries] of [
    [currentRoots.cells, [...targetRoots.cells.entries()]],
    [currentRoots.colMeta, [...targetRoots.colMeta.entries()]],
    [currentRoots.rowMeta, [...targetRoots.rowMeta.entries()]],
  ] as const) {
    for (const chunk of chunkValues(entries, ([key, value]) =>
      estimatedMapEntryBytes(key, value),
    )) {
      transact(() => {
        for (const [key, value] of chunk) currentMap.set(key, copyYMap(value));
      });
    }
  }
  return updates;
}

function replaceBoardStateInChunks(
  current: Y.Doc,
  target: Y.Doc,
  origin: "restore",
): ArrayBuffer[] {
  const currentRoots = getBoardRoots(current);
  const targetRoots = getBoardRoots(target);
  const updates: ArrayBuffer[] = [];
  const transact = (apply: () => void) => {
    const vector = Y.encodeStateVector(current);
    current.transact(apply, origin);
    const update = Y.encodeStateAsUpdate(current, vector);
    if (update.byteLength === 0) return;
    if (update.byteLength > MAX_COLLAB_UPDATE_BYTES) throw new Error("update-too-large");
    updates.push(toArrayBuffer(update));
  };
  while (currentRoots.columns.length > 0) {
    transact(() => currentRoots.columns.delete(0, Math.min(currentRoots.columns.length, 512)));
  }
  for (const map of [
    currentRoots.columnMeta,
    currentRoots.cardOrder,
    currentRoots.cards,
    currentRoots.labelMeta,
  ]) {
    for (const chunk of chunkValues([...map.keys()], (key) => byteLength(key) + 64)) {
      transact(() => {
        for (const key of chunk) map.delete(key);
      });
    }
  }
  for (const chunk of chunkValues(targetRoots.columns.toArray(), (id) => byteLength(id) + 32)) {
    transact(() => currentRoots.columns.insert(currentRoots.columns.length, chunk));
  }
  for (const [currentMap, entries] of [
    [currentRoots.columnMeta, [...targetRoots.columnMeta.entries()]],
    [currentRoots.cards, [...targetRoots.cards.entries()]],
    [currentRoots.labelMeta, [...targetRoots.labelMeta.entries()]],
  ] as const) {
    for (const chunk of chunkValues(entries, ([key, value]) =>
      estimatedMapEntryBytes(key, value),
    )) {
      transact(() => {
        for (const [key, value] of chunk) currentMap.set(key, copyBoardMap(value));
      });
    }
  }
  for (const chunk of chunkValues(
    [...targetRoots.cardOrder.entries()],
    ([key, value]) => byteLength(key) + value.length * 96,
  )) {
    transact(() => {
      for (const [key, value] of chunk) {
        const order = new Y.Array<string>();
        if (value.length > 0) order.insert(0, value.toArray());
        currentRoots.cardOrder.set(key, order);
      }
    });
  }
  return updates;
}

function replaceDocumentState(current: Y.Doc, target: Y.Doc, fileType: FileType): void {
  if (fileType === "view") {
    replaceViewState(current, target);
    return;
  }
  if (fileType === "chart") {
    replaceChartState(current, target);
    return;
  }
  if (fileType !== "sheet" && fileType !== "board") {
    const currentText = current.getText("codemirror");
    const targetText = target.getText("codemirror").toString();
    currentText.delete(0, currentText.length);
    if (targetText) currentText.insert(0, targetText);
    return;
  }
  if (fileType === "board") {
    const currentRoots = getBoardRoots(current);
    const targetRoots = getBoardRoots(target);
    currentRoots.columns.delete(0, currentRoots.columns.length);
    currentRoots.columnMeta.clear();
    currentRoots.cardOrder.clear();
    currentRoots.cards.clear();
    currentRoots.labelMeta.clear();
    currentRoots.columns.insert(0, targetRoots.columns.toArray());
    for (const [key, value] of targetRoots.columnMeta.entries())
      currentRoots.columnMeta.set(key, copyBoardMap(value));
    for (const [key, value] of targetRoots.cards.entries())
      currentRoots.cards.set(key, copyBoardMap(value));
    for (const [key, value] of targetRoots.labelMeta.entries())
      currentRoots.labelMeta.set(key, copyBoardMap(value));
    for (const [key, value] of targetRoots.cardOrder.entries()) {
      const order = new Y.Array<string>();
      order.insert(0, value.toArray());
      currentRoots.cardOrder.set(key, order);
    }
    return;
  }
  const currentRoots = getSheetRoots(current);
  const targetRoots = getSheetRoots(target);
  currentRoots.rows.delete(0, currentRoots.rows.length);
  currentRoots.cols.delete(0, currentRoots.cols.length);
  currentRoots.cells.clear();
  currentRoots.colMeta.clear();
  currentRoots.rowMeta.clear();
  currentRoots.rows.insert(0, targetRoots.rows.toArray());
  currentRoots.cols.insert(0, targetRoots.cols.toArray());
  for (const [key, value] of targetRoots.cells.entries())
    currentRoots.cells.set(key, copyYMap(value));
  for (const [key, value] of targetRoots.colMeta.entries())
    currentRoots.colMeta.set(key, copyYMap(value));
  for (const [key, value] of targetRoots.rowMeta.entries())
    currentRoots.rowMeta.set(key, copyYMap(value));
}

function displayName(access: { userId: string }, name?: string | null, email?: string | null) {
  return name ?? email ?? access.userId;
}

async function snapshotAuthorEmail(
  ctx: QueryCtx,
  doc: Doc<"documents">,
  snapshot: Doc<"yjsSnapshots">,
) {
  if (snapshot.authorEmail) {
    return snapshot.authorEmail;
  }
  if (!snapshot.authorUserId) {
    return undefined;
  }
  const authorUserId = snapshot.authorUserId;
  const member = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) =>
      q.eq("clerkOrgId", doc.clerkOrgId).eq("memberUserId", authorUserId),
    )
    .unique();
  return member?.email;
}

async function pruneDocumentHistory(ctx: MutationCtx, doc: Doc<"documents">) {
  const allRows = await historyRows(ctx, doc._id);
  const now = Date.now();
  const newestId = allRows[0]?._id;
  const overflow = allRows.slice(MAX_HISTORY_PER_DOC);
  for (const row of overflow) {
    if (row._id === newestId) {
      continue;
    }
    await ctx.db.delete(row._id);
  }
  const rows = allRows.slice(0, MAX_HISTORY_PER_DOC);
  let total = rows.reduce((sum, row) => sum + (row.sizeBytes ?? row.snapshot.byteLength), 0);
  const budget = HISTORY_MAX_DOCUMENT_BYTES;
  for (const row of rows.slice().reverse()) {
    if (row._id === newestId) {
      break;
    }
    if (rows.length <= 1 && total <= budget && (row.expiresAt ?? Number.POSITIVE_INFINITY) > now) {
      break;
    }
    if (total <= budget && (row.expiresAt ?? Number.POSITIVE_INFINITY) > now) {
      continue;
    }
    total -= row.sizeBytes ?? row.snapshot.byteLength;
    await ctx.db.delete(row._id);
  }
  if (allRows.length === MAX_HISTORY_PER_DOC + HISTORY_PRUNE_BATCH) {
    await ctx.scheduler.runAfter(0, internal.collab.pruneHistoryForDocument, {
      documentId: doc._id,
    });
  }
}

async function persistHistoryCheckpoint(
  ctx: MutationCtx,
  doc: Doc<"documents">,
  seq: number,
  state: ArrayBuffer,
  authorUserId: string,
  authorName: string,
  authorEmail?: string,
  label?: string,
) {
  const previewText = contentFromState(state, docFileType(doc));
  const snapshotBytes = state.byteLength + byteLength(previewText);
  if (snapshotBytes > HISTORY_MAX_DOCUMENT_BYTES) {
    throw new Error("history-too-large");
  }
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", doc.clerkOrgId))
    .unique();
  const retentionDays = clampInt(
    organization?.historyRetentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
    MIN_HISTORY_RETENTION_DAYS,
    HARD_MAX_HISTORY_RETENTION_DAYS,
  );
  const now = Date.now();
  const snapshotId = await ctx.db.insert("yjsSnapshots", {
    documentId: doc._id,
    snapshot: state,
    throughSeq: seq,
    purpose: "history",
    label: label ?? `Checkpoint ${seq}`,
    authorUserId,
    authorName,
    authorEmail,
    previewText,
    createdAt: now,
    expiresAt: now + retentionDays * DAY_MS,
    sizeBytes: snapshotBytes,
    updatedAt: now,
  });
  await pruneDocumentHistory(ctx, doc);
  return snapshotId;
}

async function tryAutoCheckpoint(
  ctx: MutationCtx,
  doc: Doc<"documents">,
  seq: number,
  state: ArrayBuffer,
  authorUserId: string,
  authorName: string,
  authorEmail?: string,
) {
  if (seq === 0) {
    return;
  }
  const rows = await historyRows(ctx, doc._id);
  if (rows[0]?.throughSeq === seq) {
    return;
  }
  try {
    await persistHistoryCheckpoint(
      ctx,
      doc,
      seq,
      state,
      authorUserId,
      authorName,
      authorEmail,
      "Auto-saved before restore",
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("history-too-large")) {
      throw error;
    }
  }
}

export const pullUpdates = query({
  args: { documentId: v.id("documents"), afterSeq: v.number() },
  handler: async (ctx, args) => {
    const projectId = await documentProject(ctx, args.documentId);
    if (!projectId || !(await accessForProject(ctx, projectId))) {
      return { snapshot: null, throughSeq: 0, updates: [] };
    }
    const snapshotRow = args.afterSeq === 0 ? await baseSnapshot(ctx, args.documentId) : null;
    const baseSeq = snapshotRow?.throughSeq ?? args.afterSeq;
    const updates = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId).gt("seq", baseSeq))
      .collect();
    return {
      snapshot: snapshotRow?.snapshot ?? null,
      throughSeq: snapshotRow?.throughSeq ?? args.afterSeq,
      updates: updates.map((row) => ({ seq: row.seq, update: row.update })),
    };
  },
});

export const pushUpdateV2 = mutation({
  args: { documentId: v.id("documents"), update: v.bytes() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || (await isInactiveTree(ctx, doc))) {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    const allowed = await enforceWriteRateLimit(
      ctx,
      "collab",
      args.documentId,
      access.userId,
      COLLAB_WRITE_LIMIT,
    );
    if (!allowed) {
      return { ok: false as const, error: "rate-limited" as const };
    }
    if (args.update.byteLength > MAX_COLLAB_UPDATE_BYTES) {
      return { ok: false as const, error: "update-too-large" as const };
    }
    let materialized: Awaited<ReturnType<typeof materializedContent>>;
    try {
      materialized = await materializedContent(ctx, doc, args.update);
    } catch (error) {
      if (error instanceof SheetValidationError || error instanceof BoardValidationError) {
        return { ok: false as const, error: error.code };
      }
      if (error instanceof ViewValidationError || error instanceof ChartValidationError) {
        return { ok: false as const, error: "invalid-update" as const };
      }
      return { ok: false as const, error: "invalid-update" as const };
    }
    if (!materialized) {
      return { ok: false as const, error: "invalid-update" as const };
    }
    const {
      content,
      state,
      replayed,
      size: newSize,
      sheetMeta,
      boardMeta,
      cleanupUpdate,
    } = materialized;
    if (
      byteLength(content) > MAX_FILE_BYTES ||
      (doc.fileType === "sheet" && newSize > MAX_SHEET_STORED_BYTES) ||
      (doc.fileType === "board" && newSize > MAX_BOARD_STORED_BYTES) ||
      (doc.fileType === "view" && newSize > MAX_VIEW_STORED_BYTES) ||
      (doc.fileType === "chart" && newSize > MAX_CHART_STORED_BYTES)
    ) {
      return { ok: false as const, error: "file-too-large" as const };
    }
    const total = await cachedProjectBytes(ctx, access.project);
    const max = await maxProjectBytes(ctx, access.project);
    if (total - doc.size + newSize > max) {
      return { ok: false as const, error: "project-full" as const };
    }
    let seq: number;
    try {
      seq = await allocateSeq(ctx, args.documentId);
    } catch (error) {
      if (error instanceof Error && error.message === "seq-conflict") {
        return { ok: false as const, error: "seq-conflict" as const };
      }
      throw error;
    }
    await ctx.db.insert("yjsUpdates", {
      documentId: args.documentId,
      seq,
      update: args.update,
      createdAt: Date.now(),
    });
    if (cleanupUpdate) {
      seq = await allocateSeq(ctx, args.documentId);
      await ctx.db.insert("yjsUpdates", {
        documentId: args.documentId,
        seq,
        update: cleanupUpdate,
        createdAt: Date.now(),
      });
    }
    await syncBoardLinkIndex(ctx, doc, state, access.userId);
    await ctx.db.patch(doc._id, {
      content,
      contentSeq: seq,
      contentState: state,
      size: newSize,
      sheetMeta,
      boardMeta,
      updatedAt: Date.now(),
    });
    await addProjectBytes(ctx, access.project, newSize - doc.size);
    if (seq % COMPACT_THRESHOLD === 0 || replayed > COMPACT_THRESHOLD) {
      await ctx.scheduler.runAfter(0, internal.collab.compactDocument, {
        documentId: args.documentId,
      });
    }
    return { ok: true as const, seq };
  },
});

export const replaceSheetFromImport = mutation({
  args: {
    documentId: v.id("documents"),
    expectedSeq: v.number(),
    updates: v.array(v.bytes()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || doc.fileType !== "sheet" || (await isInactiveTree(ctx, doc))) {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    const allowed = await enforceWriteRateLimit(
      ctx,
      "collab",
      doc._id,
      access.userId,
      COLLAB_WRITE_LIMIT,
    );
    if (!allowed) return { ok: false as const, error: "rate-limited" as const };
    if (args.updates.length < 1 || args.updates.length > 32) {
      return { ok: false as const, error: "invalid-update" as const };
    }
    if (args.updates.some((update) => update.byteLength > MAX_COLLAB_UPDATE_BYTES)) {
      return { ok: false as const, error: "update-too-large" as const };
    }
    if ((await latestSeq(ctx, doc._id)) !== args.expectedSeq) {
      return { ok: false as const, error: "import-conflict" as const };
    }
    const target = new Y.Doc();
    try {
      for (const update of args.updates) Y.applyUpdate(target, new Uint8Array(update));
      const inspection = inspectSheet(target);
      if (inspection.rows.length === 0 || inspection.cols.length === 0) {
        target.destroy();
        return { ok: false as const, error: "invalid-update" as const };
      }
    } catch (error) {
      target.destroy();
      if (error instanceof SheetValidationError) {
        return { ok: false as const, error: error.code };
      }
      return { ok: false as const, error: "invalid-update" as const };
    }
    const targetContent = project("sheet", target);
    const targetSize = documentSize("sheet", target);
    if (byteLength(targetContent) > MAX_FILE_BYTES || targetSize > MAX_SHEET_STORED_BYTES) {
      target.destroy();
      return { ok: false as const, error: "file-too-large" as const };
    }
    const currentState = await materializedState(ctx, doc);
    const current = new Y.Doc();
    Y.applyUpdate(current, new Uint8Array(currentState));
    let replacementUpdates: ArrayBuffer[];
    try {
      replacementUpdates = replaceSheetStateInChunks(current, target, "import");
    } catch (error) {
      current.destroy();
      target.destroy();
      return {
        ok: false as const,
        error:
          error instanceof Error && error.message === "update-too-large"
            ? ("update-too-large" as const)
            : ("invalid-update" as const),
      };
    }
    const content = project("sheet", current);
    const size = documentSize("sheet", current);
    const sheetMeta = inspectSheet(current).dimensions;
    const state = toArrayBuffer(Y.encodeStateAsUpdate(current));
    current.destroy();
    target.destroy();
    if (byteLength(content) > MAX_FILE_BYTES || size > MAX_SHEET_STORED_BYTES) {
      return { ok: false as const, error: "file-too-large" as const };
    }
    const total = await cachedProjectBytes(ctx, access.project);
    if (total - doc.size + size > (await maxProjectBytes(ctx, access.project))) {
      return { ok: false as const, error: "project-full" as const };
    }
    let seq = args.expectedSeq;
    const now = Date.now();
    for (const update of replacementUpdates) {
      seq = await allocateSeq(ctx, doc._id);
      await ctx.db.insert("yjsUpdates", { documentId: doc._id, seq, update, createdAt: now });
    }
    await ctx.db.patch(doc._id, {
      content,
      contentSeq: seq,
      contentState: state,
      sheetMeta,
      size,
      updatedAt: now,
    });
    await syncBoardLinkIndex(ctx, doc, state, access.userId);
    await addProjectBytes(ctx, access.project, size - doc.size);
    return { ok: true as const, seq };
  },
});

export const compactDocument = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      return;
    }
    const ydoc = new Y.Doc();
    const snapshot = await baseSnapshot(ctx, args.documentId);
    if (snapshot) {
      Y.applyUpdate(ydoc, new Uint8Array(snapshot.snapshot));
    }
    const baseSeq = snapshot?.throughSeq ?? 0;
    const updates = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId).gt("seq", baseSeq))
      .collect();
    if (updates.length === 0) {
      ydoc.destroy();
      return;
    }
    let maxSeq = baseSeq;
    for (const row of updates) {
      Y.applyUpdate(ydoc, new Uint8Array(row.update));
      if (row.seq > maxSeq) {
        maxSeq = row.seq;
      }
    }
    const encoded = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    if (snapshot) {
      await ctx.db.patch(snapshot._id, {
        snapshot: encoded,
        throughSeq: maxSeq,
        purpose: "base",
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("yjsSnapshots", {
        documentId: args.documentId,
        snapshot: encoded,
        throughSeq: maxSeq,
        purpose: "base",
        updatedAt: Date.now(),
      });
    }
    const pruneThrough = maxSeq - COMPACT_OVERLAP;
    if (pruneThrough <= 0) {
      return;
    }
    const stale = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId).lte("seq", pruneThrough))
      .collect();
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
  },
});

export const ensureSeed = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    await requireProjectEditor(ctx, doc.projectId);
    if (doc.fileType === "view") {
      await ctx.scheduler.runAfter(0, internal.collab.backfillProjectBoardIndexes, {
        projectId: doc.projectId,
      });
    }
    const existing = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .first();
    const snapshot = await baseSnapshot(ctx, args.documentId);
    if (
      existing ||
      snapshot ||
      (doc.fileType !== "sheet" &&
        doc.fileType !== "board" &&
        doc.fileType !== "view" &&
        doc.fileType !== "chart" &&
        doc.content.length === 0)
    ) {
      return { seeded: false };
    }
    const seedDoc = new Y.Doc();
    if (doc.fileType === "sheet") {
      seedSheet(seedDoc);
    } else if (doc.fileType === "board") {
      seedBoard(seedDoc);
    } else if (doc.fileType === "view") {
      seedView(seedDoc);
    } else if (doc.fileType === "chart") {
      seedChart(seedDoc);
    } else {
      seedDoc.getText("codemirror").insert(0, doc.content);
    }
    const update = Y.encodeStateAsUpdate(seedDoc);
    const state = toArrayBuffer(update);
    const content = project(docFileType(doc), seedDoc);
    const size = documentSize(docFileType(doc), seedDoc);
    const sheetMeta = doc.fileType === "sheet" ? inspectSheet(seedDoc).dimensions : undefined;
    const boardMeta = doc.fileType === "board" ? inspectBoard(seedDoc).dimensions : undefined;
    seedDoc.destroy();
    await ctx.db.insert("yjsUpdates", {
      documentId: args.documentId,
      seq: 1,
      update: state,
      createdAt: Date.now(),
    });
    await ctx.db.patch(doc._id, {
      contentSeq: 1,
      contentState: state,
      content,
      size,
      sheetMeta,
      boardMeta,
    });
    if (size !== doc.size) {
      const projectRow = await ctx.db.get(doc.projectId);
      if (projectRow) await addProjectBytes(ctx, projectRow, size - doc.size);
    }
    return { seeded: true };
  },
});

export const listHistory = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || !(await accessForProject(ctx, doc.projectId))) {
      return [];
    }
    const rows = await historyRows(ctx, args.documentId);
    const total = rows.length;
    return await Promise.all(
      rows.map(async (row, index) => ({
        id: row._id,
        versionNumber: total - index,
        authorName: row.authorName ?? "Unknown",
        authorEmail: await snapshotAuthorEmail(ctx, doc, row),
        createdAt: row.createdAt ?? row.updatedAt,
        throughSeq: row.throughSeq,
        sizeBytes: row.sizeBytes ?? row.snapshot.byteLength,
      })),
    );
  },
});

export const createHistoryCheckpoint = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    const seq = await latestSeq(ctx, doc._id);
    if (seq === 0) {
      return { seq, created: false };
    }
    const rows = await historyRows(ctx, doc._id);
    if (rows[0]?.throughSeq === seq) {
      return { seq, created: false };
    }
    const state = await materializedState(ctx, doc);
    const identity = await ctx.auth.getUserIdentity();
    const snapshotId = await persistHistoryCheckpoint(
      ctx,
      doc,
      seq,
      state,
      access.userId,
      displayName(access, identity?.name, identity?.email),
      identity?.email,
    );
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "checkpoint_created",
      documentId: doc._id,
      checkpointId: snapshotId,
      targetName: doc.name,
      detail: `Checkpoint ${seq}`,
    });
    return { seq, created: true };
  },
});

export const deleteHistoryBatch = internalMutation({
  args: { confirm: v.string() },
  handler: async (ctx, args) => {
    if (args.confirm !== "delete-all-version-history") {
      throw new Error("invalid-confirmation");
    }
    const rows = await ctx.db
      .query("yjsSnapshots")
      .withIndex("by_purpose_created", (q) => q.eq("purpose", "history"))
      .take(200);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, hasMore: rows.length === 200 };
  },
});

export const pruneHistoryForDocument = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      return { found: false };
    }
    await pruneDocumentHistory(ctx, doc);
    return { found: true };
  },
});

export const deleteHistoryCheckpoint = mutation({
  args: { snapshotId: v.id("yjsSnapshots") },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db.get(args.snapshotId);
    if (snapshot?.purpose !== "history") {
      throw new Error("not-found");
    }
    const doc = await ctx.db.get(snapshot.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    const access = await requireProjectAdmin(ctx, doc.projectId);
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "checkpoint_deleted",
      documentId: doc._id,
      checkpointId: snapshot._id,
      targetName: doc.name,
      detail: snapshot.label ?? `Checkpoint ${snapshot.throughSeq}`,
    });
    await ctx.db.delete(args.snapshotId);
    return { deleted: true };
  },
});

export const getHistoryPreview = query({
  args: { snapshotId: v.id("yjsSnapshots") },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db.get(args.snapshotId);
    if (snapshot?.purpose !== "history") {
      return null;
    }
    const doc = await ctx.db.get(snapshot.documentId);
    if (doc?.kind !== "file" || !(await accessForProject(ctx, doc.projectId))) {
      return null;
    }
    return {
      content: snapshot.previewText ?? contentFromState(snapshot.snapshot, docFileType(doc)),
      fileType: docFileType(doc),
      sheetPreview: doc.fileType === "sheet" ? sheetPreviewFromState(snapshot.snapshot) : undefined,
      boardPreview: doc.fileType === "board" ? boardPreviewFromState(snapshot.snapshot) : undefined,
      viewPreview: doc.fileType === "view" ? viewPreviewFromState(snapshot.snapshot) : undefined,
      chartPreview:
        doc.fileType === "chart"
          ? await chartPreviewFromState(ctx, doc, snapshot.snapshot)
          : undefined,
      label: snapshot.label ?? `Snapshot ${snapshot.throughSeq}`,
      authorName: snapshot.authorName ?? "Unknown",
      authorEmail: await snapshotAuthorEmail(ctx, doc, snapshot),
      createdAt: snapshot.createdAt ?? snapshot.updatedAt,
    };
  },
});

export const restoreHistory = mutation({
  args: { snapshotId: v.id("yjsSnapshots") },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db.get(args.snapshotId);
    if (snapshot?.purpose !== "history") {
      throw new Error("not-found");
    }
    const doc = await ctx.db.get(snapshot.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    const access = await requireProjectAdmin(ctx, doc.projectId);
    const fileType = docFileType(doc);
    const targetDoc = new Y.Doc();
    Y.applyUpdate(targetDoc, new Uint8Array(snapshot.snapshot));
    const targetContent = project(fileType, targetDoc);
    const newSize = documentSize(fileType, targetDoc);
    if (
      byteLength(targetContent) > MAX_FILE_BYTES ||
      (fileType === "sheet" && newSize > MAX_SHEET_STORED_BYTES) ||
      (fileType === "board" && newSize > MAX_BOARD_STORED_BYTES) ||
      (fileType === "view" && newSize > MAX_VIEW_STORED_BYTES) ||
      (fileType === "chart" && newSize > MAX_CHART_STORED_BYTES)
    ) {
      targetDoc.destroy();
      throw new Error("file-too-large");
    }
    const currentState = await materializedState(ctx, doc);
    const currentSeq = await latestSeq(ctx, doc._id);
    const identity = await ctx.auth.getUserIdentity();
    await tryAutoCheckpoint(
      ctx,
      doc,
      currentSeq,
      currentState,
      access.userId,
      displayName(access, identity?.name, identity?.email),
      identity?.email,
    );
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(currentState));
    let replacementUpdates: ArrayBuffer[];
    if (fileType === "sheet") {
      replacementUpdates = replaceSheetStateInChunks(ydoc, targetDoc, "restore");
    } else if (fileType === "board") {
      replacementUpdates = replaceBoardStateInChunks(ydoc, targetDoc, "restore");
    } else {
      const vector = Y.encodeStateVector(ydoc);
      ydoc.transact(() => replaceDocumentState(ydoc, targetDoc, fileType), "restore");
      replacementUpdates = [toArrayBuffer(Y.encodeStateAsUpdate(ydoc, vector))];
    }
    const restoredContent = project(fileType, ydoc);
    const restoredSize = documentSize(fileType, ydoc);
    const restoredSheetMeta = fileType === "sheet" ? inspectSheet(ydoc).dimensions : undefined;
    const restoredBoardMeta = fileType === "board" ? inspectBoard(ydoc).dimensions : undefined;
    const state = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    targetDoc.destroy();
    if (
      byteLength(restoredContent) > MAX_FILE_BYTES ||
      (fileType === "sheet" && restoredSize > MAX_SHEET_STORED_BYTES) ||
      (fileType === "board" && restoredSize > MAX_BOARD_STORED_BYTES) ||
      (fileType === "view" && restoredSize > MAX_VIEW_STORED_BYTES) ||
      (fileType === "chart" && restoredSize > MAX_CHART_STORED_BYTES)
    ) {
      throw new Error("file-too-large");
    }
    const total = await cachedProjectBytes(ctx, access.project);
    const max = await maxProjectBytes(ctx, access.project);
    if (total - doc.size + restoredSize > max) throw new Error("project-full");
    let seq = currentSeq;
    const now = Date.now();
    for (const update of replacementUpdates) {
      seq = await allocateSeq(ctx, doc._id);
      await ctx.db.insert("yjsUpdates", {
        documentId: doc._id,
        seq,
        update,
        createdAt: now,
      });
    }
    await ctx.db.patch(doc._id, {
      content: restoredContent,
      contentSeq: seq,
      contentState: state,
      size: restoredSize,
      sheetMeta: restoredSheetMeta,
      boardMeta: restoredBoardMeta,
      updatedAt: now,
    });
    await syncBoardLinkIndex(ctx, doc, state, access.userId);
    await addProjectBytes(ctx, access.project, restoredSize - doc.size);
    await pruneDocumentHistory(ctx, doc);
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "checkpoint_restored",
      documentId: doc._id,
      checkpointId: snapshot._id,
      targetName: doc.name,
      detail: snapshot.label ?? `Checkpoint ${snapshot.throughSeq}`,
    });
    return { seq };
  },
});

export const pruneHistory = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("yjsSnapshots")
      .withIndex("by_purpose_created", (q) => q.eq("purpose", "history"))
      .take(200);
    const documentIds = [...new Set(rows.map((row) => row.documentId))];
    for (const documentId of documentIds) {
      const doc = await ctx.db.get(documentId);
      if (doc?.kind !== "file") {
        continue;
      }
      await pruneDocumentHistory(ctx, doc);
    }
  },
});
