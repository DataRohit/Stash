import * as Y from "yjs";
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

function quoted(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
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
  return fileType === "sheet"
    ? contentBytes + Y.encodeStateAsUpdate(ydoc).byteLength
    : contentBytes;
}
