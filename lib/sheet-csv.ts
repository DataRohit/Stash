import * as Y from "yjs";
import type { SheetCell } from "./sheet-model";
import { getSheetRoots, normalizeLiteral, seedSheet, setCell } from "./sheet-model";

class DelimitedParseError extends Error {
  constructor(public readonly byteOffset: number) {
    super(`invalid-import:${byteOffset}`);
  }
}

function utf8Offset(value: string, characterOffset: number): number {
  return new TextEncoder().encode(value.slice(0, characterOffset)).byteLength;
}

export function parseDelimited(input: string, delimiter: "," | "\t"): string[][] {
  const hasBom = input.startsWith("\uFEFF");
  const source = hasBom ? input.slice(1) : input;
  const offset = (characterOffset: number) =>
    utf8Offset(source, characterOffset) + (hasBom ? 3 : 0);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let index = 0;
  let quoted = false;
  let closedQuote = false;
  const pushField = () => {
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (index < source.length) {
    const character = source[index] ?? "";
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        closedQuote = true;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (closedQuote && character !== delimiter && character !== "\r" && character !== "\n") {
      throw new DelimitedParseError(offset(index));
    }
    if (character === '"') {
      if (field.length === 0 && !closedQuote) {
        quoted = true;
        index += 1;
        continue;
      }
      throw new DelimitedParseError(offset(index));
    }
    if (character === delimiter) {
      pushField();
      index += 1;
      continue;
    }
    if (character === "\r" || character === "\n") {
      pushRow();
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      index += 1;
      continue;
    }
    field += character;
    index += 1;
  }
  if (quoted) throw new DelimitedParseError(offset(source.length));
  if (row.length > 0 || field.length > 0 || closedQuote || rows.length === 0) pushRow();
  if (
    rows.length > 1 &&
    rows.at(-1)?.length === 1 &&
    rows.at(-1)?.[0] === "" &&
    /[\r\n]$/.test(source)
  ) {
    rows.pop();
  }
  const width = rows.reduce((maximum, value) => Math.max(maximum, value.length), 0);
  return rows.map((value) => [...value, ...Array.from({ length: width - value.length }, () => "")]);
}

function quote(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

export function serializeDelimited(
  rows: readonly (readonly string[])[],
  delimiter: "," | "\t" = ",",
  lineEnding = "\r\n",
): string {
  return rows
    .map((row) => row.map((value) => quote(value, delimiter)).join(delimiter))
    .join(lineEnding);
}

function importedCell(raw: string): SheetCell {
  return normalizeLiteral(raw);
}

export function sheetImportUpdates(
  values: readonly (readonly string[])[],
  maxUpdateBytes = 700 * 1024,
  maxUpdates = 32,
): Uint8Array[] {
  const rowCount = Math.max(1, values.length);
  const colCount = Math.max(1, ...values.map((row) => row.length));
  const ydoc = new Y.Doc();
  const rawUpdates: Uint8Array[] = [];
  const onUpdate = (update: Uint8Array) => rawUpdates.push(update);
  ydoc.on("update", onUpdate);
  const inspection = seedSheet(ydoc, rowCount, colCount);
  const roots = getSheetRoots(ydoc);
  const entries = values.flatMap((row, rowIndex) =>
    row.flatMap((raw, colIndex) => (raw ? [{ rowIndex, colIndex, raw }] : [])),
  );
  let batch: typeof entries = [];
  let batchBytes = 0;
  const targetBatchBytes = Math.max(1024, Math.min(128 * 1024, Math.floor(maxUpdateBytes / 3)));
  const flush = () => {
    if (batch.length === 0) return;
    ydoc.transact(() => {
      for (const entry of batch) {
        const rowId = inspection.rows[entry.rowIndex];
        const colId = inspection.cols[entry.colIndex];
        if (!rowId || !colId) throw new Error("invalid-import");
        setCell(roots, rowId, colId, importedCell(entry.raw));
      }
    }, "sheet-import");
    batch = [];
    batchBytes = 0;
  };
  for (const entry of entries) {
    const bytes = new TextEncoder().encode(entry.raw).byteLength + 160;
    if (batch.length > 0 && batchBytes + bytes > targetBatchBytes) flush();
    batch.push(entry);
    batchBytes += bytes;
  }
  flush();
  ydoc.off("update", onUpdate);
  ydoc.destroy();
  const packed: Uint8Array[] = [];
  let current: Uint8Array | null = null;
  for (const update of rawUpdates) {
    if (update.byteLength > maxUpdateBytes) throw new Error("update-too-large");
    const merged: Uint8Array = current ? Y.mergeUpdates([current, update]) : update;
    if (current && merged.byteLength > maxUpdateBytes) {
      packed.push(current);
      current = update;
    } else {
      current = merged;
    }
  }
  if (current) packed.push(current);
  if (packed.length > maxUpdates) throw new Error("file-too-large");
  return packed;
}
