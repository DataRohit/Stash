import * as Y from "yjs";

const DEFAULT_SHEET_ROWS = 100;
const DEFAULT_SHEET_COLS = 26;
export const MAX_SHEET_ROWS = 10_000;
export const MAX_SHEET_COLS = 200;
export const MAX_SHEET_CELLS = 100_000;
export const MAX_SHEET_PROJECTION_BYTES = 512 * 1024;
export const MAX_SHEET_UPDATE_BYTES = 768 * 1024;
export const MAX_SHEET_STORED_BYTES = 896 * 1024;
const MAX_CELL_FIELD_LENGTH = 16 * 1024;
export const DEFAULT_COLUMN_WIDTH = 120;
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 600;
export const DEFAULT_ROW_HEIGHT = 28;
export const MIN_ROW_HEIGHT = 24;
export const MAX_ROW_HEIGHT = 200;

export type SheetCellType = "text" | "number" | "bool" | "date";
export type SheetCellValue = string | number | boolean | null;

export type SheetCell = {
  raw: string;
  type: SheetCellType;
  value: SheetCellValue;
  formula: string | null;
  display: string;
};

export type SheetRoots = {
  rows: Y.Array<string>;
  cols: Y.Array<string>;
  cells: Y.Map<Y.Map<unknown>>;
  colMeta: Y.Map<Y.Map<unknown>>;
  rowMeta: Y.Map<Y.Map<unknown>>;
};

export type SheetInspection = {
  rows: string[];
  cols: string[];
  rowSet: Set<string>;
  colSet: Set<string>;
  dimensions: { rows: number; cols: number };
};

export class SheetValidationError extends Error {
  constructor(public readonly code: "invalid-update" | "too-many-cells") {
    super(code);
  }
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function columnLabel(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function columnIndex(label: string): number {
  let value = 0;
  for (const character of label.toUpperCase()) {
    if (character < "A" || character > "Z") return -1;
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value - 1;
}

export function getSheetRoots(ydoc: Y.Doc): SheetRoots {
  return {
    rows: ydoc.getArray<string>("rows"),
    cols: ydoc.getArray<string>("cols"),
    cells: ydoc.getMap<Y.Map<unknown>>("cells"),
    colMeta: ydoc.getMap<Y.Map<unknown>>("colMeta"),
    rowMeta: ydoc.getMap<Y.Map<unknown>>("rowMeta"),
  };
}

function sheetCellKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

export function seedSheet(
  ydoc: Y.Doc,
  rowCount = DEFAULT_SHEET_ROWS,
  colCount = DEFAULT_SHEET_COLS,
  idFactory: () => string = randomId,
): SheetInspection {
  if (
    rowCount < 1 ||
    colCount < 1 ||
    rowCount > MAX_SHEET_ROWS ||
    colCount > MAX_SHEET_COLS ||
    rowCount * colCount > MAX_SHEET_CELLS
  ) {
    throw new SheetValidationError("too-many-cells");
  }
  const roots = getSheetRoots(ydoc);
  if (roots.rows.length > 0 || roots.cols.length > 0) return inspectSheet(ydoc);
  const rowIds = Array.from({ length: rowCount }, idFactory);
  const colIds = Array.from({ length: colCount }, idFactory);
  ydoc.transact(() => {
    roots.rows.insert(0, rowIds);
    roots.cols.insert(0, colIds);
    for (const [index, colId] of colIds.entries()) {
      const meta = new Y.Map<unknown>();
      meta.set("width", DEFAULT_COLUMN_WIDTH);
      meta.set("name", columnLabel(index));
      roots.colMeta.set(colId, meta);
    }
    for (const rowId of rowIds) {
      const meta = new Y.Map<unknown>();
      meta.set("height", DEFAULT_ROW_HEIGHT);
      roots.rowMeta.set(rowId, meta);
    }
  }, "seed");
  return inspectSheet(ydoc);
}

function uniqueIds(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isValidSheetId(value)) {
      throw new SheetValidationError("invalid-update");
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function isValidSheetId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function validMetaNumber(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function inspectSheet(ydoc: Y.Doc): SheetInspection {
  const roots = getSheetRoots(ydoc);
  const rows = uniqueIds(roots.rows.toArray());
  const cols = uniqueIds(roots.cols.toArray());
  if (
    rows.length > MAX_SHEET_ROWS ||
    cols.length > MAX_SHEET_COLS ||
    rows.length * cols.length > MAX_SHEET_CELLS
  ) {
    throw new SheetValidationError("too-many-cells");
  }
  const rowSet = new Set(rows);
  const colSet = new Set(cols);
  for (const [key, cellMap] of roots.cells.entries()) {
    const separator = key.indexOf(":");
    if (
      separator < 1 ||
      separator !== key.lastIndexOf(":") ||
      !isValidSheetId(key.slice(0, separator)) ||
      !isValidSheetId(key.slice(separator + 1)) ||
      !(cellMap instanceof Y.Map)
    ) {
      throw new SheetValidationError("invalid-update");
    }
    readCellMap(cellMap);
  }
  for (const [id, meta] of roots.colMeta.entries()) {
    if (!isValidSheetId(id) || !(meta instanceof Y.Map))
      throw new SheetValidationError("invalid-update");
    const width = meta.get("width");
    const name = meta.get("name");
    if (
      !validMetaNumber(width, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH) ||
      typeof name !== "string" ||
      name.length > 80
    ) {
      throw new SheetValidationError("invalid-update");
    }
  }
  for (const [id, meta] of roots.rowMeta.entries()) {
    if (!isValidSheetId(id) || !(meta instanceof Y.Map))
      throw new SheetValidationError("invalid-update");
    if (!validMetaNumber(meta.get("height"), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT)) {
      throw new SheetValidationError("invalid-update");
    }
  }
  if (rows.some((id) => !roots.rowMeta.has(id)) || cols.some((id) => !roots.colMeta.has(id))) {
    throw new SheetValidationError("invalid-update");
  }
  return { rows, cols, rowSet, colSet, dimensions: { rows: rows.length, cols: cols.length } };
}

function isCellType(value: unknown): value is SheetCellType {
  return value === "text" || value === "number" || value === "bool" || value === "date";
}

function readCellMap(cellMap: Y.Map<unknown>): SheetCell {
  const raw = cellMap.get("raw");
  const type = cellMap.get("type");
  const value = cellMap.get("value");
  const formula = cellMap.get("formula");
  const display = cellMap.get("display");
  if (
    typeof raw !== "string" ||
    raw.length > MAX_CELL_FIELD_LENGTH ||
    !isCellType(type) ||
    !(
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) ||
    (typeof value === "number" && !Number.isFinite(value)) ||
    !(
      formula === null ||
      (typeof formula === "string" && formula.length <= MAX_CELL_FIELD_LENGTH)
    ) ||
    typeof display !== "string" ||
    display.length > MAX_CELL_FIELD_LENGTH
  ) {
    throw new SheetValidationError("invalid-update");
  }
  if (formula !== null) {
    if (type !== "text" || value !== null || !raw.startsWith("=") || !formula.startsWith("=")) {
      throw new SheetValidationError("invalid-update");
    }
  } else {
    const trimmed = raw.trim();
    const validLiteral =
      display.length === 0 &&
      ((type === "text" && value === raw) ||
        (type === "number" &&
          typeof value === "number" &&
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) &&
          Number(trimmed) === value) ||
        (type === "bool" &&
          typeof value === "boolean" &&
          /^(?:true|false)$/i.test(trimmed) &&
          (trimmed.toLowerCase() === "true") === value) ||
        (type === "date" && typeof value === "string" && value === trimmed && isIsoDate(value)));
    if (!validLiteral) throw new SheetValidationError("invalid-update");
  }
  return { raw, type, value, formula, display };
}

export function readCell(roots: SheetRoots, rowId: string, colId: string): SheetCell | null {
  const value = roots.cells.get(sheetCellKey(rowId, colId));
  return value ? readCellMap(value) : null;
}

function cellMapFor(cell: SheetCell): Y.Map<unknown> {
  const result = new Y.Map<unknown>();
  result.set("raw", cell.raw);
  result.set("type", cell.type);
  result.set("value", cell.value);
  result.set("formula", cell.formula);
  result.set("display", cell.display);
  return result;
}

export function setCell(
  roots: SheetRoots,
  rowId: string,
  colId: string,
  cell: SheetCell | null,
): void {
  const key = sheetCellKey(rowId, colId);
  if (!cell || (cell.raw.length === 0 && cell.formula === null)) {
    roots.cells.delete(key);
    return;
  }
  roots.cells.set(key, cellMapFor(cell));
}

export function normalizeLiteral(raw: string, requestedType?: SheetCellType): SheetCell {
  const trimmed = raw.trim();
  const invariantNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed);
  const finiteNumber = invariantNumber && Number.isFinite(Number(trimmed));
  const inferred: SheetCellType =
    requestedType ??
    (/^(?:true|false)$/i.test(trimmed)
      ? "bool"
      : finiteNumber
        ? "number"
        : isIsoDate(trimmed)
          ? "date"
          : "text");
  let value: SheetCellValue = raw;
  if (inferred === "number") {
    const parsed = Number(trimmed);
    value = Number.isFinite(parsed) ? parsed : null;
  } else if (inferred === "bool") {
    value = /^(?:true|false)$/i.test(trimmed) ? trimmed.toLowerCase() === "true" : null;
  } else if (inferred === "date") {
    value = isIsoDate(trimmed) ? trimmed : null;
  }
  return { raw, type: inferred, value, formula: null, display: "" };
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function displayedCellValue(cell: SheetCell | null): string {
  if (!cell) return "";
  return cell.formula === null ? cell.raw : cell.display;
}
