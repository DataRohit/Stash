import * as Y from "yjs";
import { getBoardRoots, inspectBoard, orderedCards, UNFILED_COLUMN_ID } from "./board-model";
import type { FileType } from "./document-types";
import {
  DEFAULT_COLUMN_WIDTH,
  displayedCellValue,
  getSheetRoots,
  inspectSheet,
  readCell,
} from "./sheet-model";

export type SheetRenderModel = {
  columns: Array<{ id: string; name: string; width: number }>;
  rows: Array<{ id: string; values: string[] }>;
};

export type BoardRenderModel = {
  columns: Array<{
    id: string;
    name: string;
    color: string;
    cards: Array<{
      id: string;
      title: string;
      description: string;
      assignees: string[];
      labels: Array<{ id: string; name: string; color: string }>;
      due: number | null;
      linkedDocId: string | null;
      linkedDocRemoved?: boolean;
      color: string;
      priority: "low" | "medium" | "high" | "critical" | null;
    }>;
  }>;
  unfiledCards: number;
};

function quoted(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function plainMarkdown(value: string): string {
  return value
    .replace(/^\s*```[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function trimmedSheet(ydoc: Y.Doc) {
  const inspection = inspectSheet(ydoc);
  const roots = getSheetRoots(ydoc);
  let lastRow = -1;
  let lastCol = -1;
  for (const [rowIndex, rowId] of inspection.rows.entries()) {
    for (const [colIndex, colId] of inspection.cols.entries()) {
      if (displayedCellValue(readCell(roots, rowId, colId)).length > 0) {
        lastRow = Math.max(lastRow, rowIndex);
        lastCol = Math.max(lastCol, colIndex);
      }
    }
  }
  return {
    roots,
    rows: inspection.rows.slice(0, lastRow + 1),
    cols: inspection.cols.slice(0, lastCol + 1),
  };
}

export function project(fileType: FileType, ydoc: Y.Doc): string {
  if (fileType === "board") {
    const roots = getBoardRoots(ydoc);
    const inspection = inspectBoard(ydoc);
    const sections = inspection.columns.map((columnId) => {
      const name = String(roots.columnMeta.get(columnId)?.get("name") ?? "");
      const cards = orderedCards(roots, inspection, columnId);
      return [name, ...cards.flatMap((card) => [card.title, plainMarkdown(card.description)])]
        .filter(Boolean)
        .join("\n");
    });
    const unfiled = orderedCards(roots, inspection, UNFILED_COLUMN_ID);
    if (unfiled.length > 0) {
      sections.push(
        ["Unfiled", ...unfiled.flatMap((card) => [card.title, plainMarkdown(card.description)])]
          .filter(Boolean)
          .join("\n"),
      );
    }
    return sections.filter(Boolean).join("\n\n");
  }
  if (fileType !== "sheet") return ydoc.getText("codemirror").toString();
  const { roots, rows, cols } = trimmedSheet(ydoc);
  return rows
    .map((rowId) =>
      cols
        .map((colId) => quoted(displayedCellValue(readCell(roots, rowId, colId)), "\t"))
        .join("\t"),
    )
    .join("\n");
}

export function boardRenderModel(ydoc: Y.Doc): BoardRenderModel {
  const roots = getBoardRoots(ydoc);
  const inspection = inspectBoard(ydoc);
  const unfiled = orderedCards(roots, inspection, UNFILED_COLUMN_ID);
  const cardModel = (card: ReturnType<typeof orderedCards>[number]) => ({
    id: card.id,
    title: card.title,
    description: card.description,
    assignees: card.assignees,
    labels: card.labels.flatMap((labelId) => {
      const meta = roots.labelMeta.get(labelId);
      return meta
        ? [
            {
              id: labelId,
              name: String(meta.get("name") ?? ""),
              color: String(meta.get("color") ?? "#64748b"),
            },
          ]
        : [];
    }),
    due: card.due,
    linkedDocId: card.linkedDocId,
    linkedDocRemoved: false,
    color: card.color,
    priority: card.priority,
  });
  return {
    columns: [
      ...inspection.columns.map((id) => ({
        id,
        name: String(roots.columnMeta.get(id)?.get("name") ?? ""),
        color: String(roots.columnMeta.get(id)?.get("color") ?? "#64748b"),
        cards: orderedCards(roots, inspection, id).map(cardModel),
      })),
      ...(unfiled.length > 0
        ? [
            {
              id: UNFILED_COLUMN_ID,
              name: "Unfiled",
              color: "#f59e0b",
              cards: unfiled.map(cardModel),
            },
          ]
        : []),
    ],
    unfiledCards: unfiled.length,
  };
}

export function sheetRenderModel(ydoc: Y.Doc): SheetRenderModel {
  const inspection = inspectSheet(ydoc);
  const roots = getSheetRoots(ydoc);
  const projected = trimmedSheet(ydoc);
  const cols = projected.cols.length > 0 ? projected.cols : inspection.cols.slice(0, 1);
  const rows = projected.rows.length > 0 ? projected.rows : inspection.rows.slice(0, 1);
  return {
    columns: cols.map((id) => {
      const meta = roots.colMeta.get(id);
      return {
        id,
        name: String(meta?.get("name") ?? ""),
        width: Number(meta?.get("width") ?? DEFAULT_COLUMN_WIDTH),
      };
    }),
    rows: rows.map((id) => ({
      id,
      values: cols.map((colId) => displayedCellValue(readCell(roots, id, colId))),
    })),
  };
}

export function documentSize(fileType: FileType, ydoc: Y.Doc): number {
  const projection = project(fileType, ydoc);
  const contentBytes = new TextEncoder().encode(projection).byteLength;
  return fileType === "sheet" || fileType === "board"
    ? contentBytes + Y.encodeStateAsUpdate(ydoc).byteLength
    : contentBytes;
}
