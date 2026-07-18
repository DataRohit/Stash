"use client";

import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Filter,
  MessageSquarePlus,
  Palette,
  Plus,
  Redo2,
  Snowflake,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Dialog } from "@/components/ui/dialog";
import { notify } from "@/components/ui/toast";
import { documentSize, project } from "@/lib/doc-projection";
import { parseDelimited, serializeDelimited } from "@/lib/sheet-csv";
import { formulaToA1, formulaToInternal, recomputeFormulas } from "@/lib/sheet-formulas";
import {
  columnLabel,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  displayedCellValue,
  formatColorForCell,
  getSheetRoots,
  inspectSheet,
  MAX_COLUMN_WIDTH,
  MAX_ROW_HEIGHT,
  MAX_SHEET_CELLS,
  MAX_SHEET_COLS,
  MAX_SHEET_FORMAT_RULES,
  MAX_SHEET_PROJECTION_BYTES,
  MAX_SHEET_ROWS,
  MAX_SHEET_STORED_BYTES,
  MAX_SHEET_UPDATE_BYTES,
  MAX_SHEET_VALIDATION_RULES,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  normalizeLiteral,
  readCell,
  readFormatRules,
  readSheetSettings,
  readValidationRules,
  type SheetCell,
  SheetValidationError,
  setCell,
  sheetRangeIndex,
  validationForCell,
} from "@/lib/sheet-model";
import { cn } from "@/lib/utils";

type Point = { rowId: string; colId: string };
type Selection = { anchor: Point; focus: Point };

export type SheetCellSelection = Point & { quote: string };

type SheetEditorProps = {
  ydoc: Y.Doc | undefined;
  awareness: Awareness | undefined;
  readOnly: boolean;
  documentId: string;
  activeComment?: Point | null;
  onSelectionChange?: (selection: SheetCellSelection | null) => void;
  onAddComment?: () => void;
  onImportFile?: (file: File) => Promise<void>;
};

const ROW_HEADER_WIDTH = 52;
const HEADER_HEIGHT = 32;

function id(): string {
  return crypto.randomUUID();
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error("invalid-sheet-index");
  return item;
}

function cellInput(cell: SheetCell | null, rows: string[], cols: string[]): string {
  if (!cell) return "";
  if (cell.formula) {
    try {
      return formulaToA1(cell.formula, rows, cols);
    } catch {
      return cell.raw;
    }
  }
  return cell.raw;
}

function storageKey(documentId: string): string {
  return `stash:sheet-view:${documentId}`;
}

function writePastedValues(
  ydoc: Y.Doc,
  visibleRows: string[],
  naturalRows: string[],
  cols: string[],
  values: string[][],
  rowStart: number,
  colStart: number,
): void {
  const roots = getSheetRoots(ydoc);
  ydoc.transact(() => {
    values.forEach((row, rowOffset) => {
      row.forEach((raw, colOffset) => {
        const rowId = itemAt(visibleRows, rowStart + rowOffset);
        const colId = itemAt(cols, colStart + colOffset);
        if (!raw) setCell(roots, rowId, colId, null);
        else if (raw.startsWith("=")) {
          setCell(roots, rowId, colId, {
            raw,
            type: "text",
            value: null,
            formula: formulaToInternal(raw, naturalRows, cols),
            display: "",
          });
        } else setCell(roots, rowId, colId, normalizeLiteral(raw));
      });
    });
    recomputeFormulas(ydoc);
  }, "sheet-paste");
}

export function SheetEditor({
  ydoc,
  awareness,
  readOnly,
  documentId,
  activeComment,
  onSelectionChange,
  onAddComment,
  onImportFile,
}: SheetEditorProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resizedRef = useRef(false);
  const reorderedRef = useRef(false);
  const selectionDragRef = useRef<{ pointerId: number; anchor: Point } | null>(null);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ colId: string; direction: "asc" | "desc" } | null>(null);
  const [remoteRevision, setRemoteRevision] = useState(0);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [resizeTarget, setResizeTarget] = useState<{ kind: "row" | "col"; id: string } | null>(
    null,
  );
  const [rulesOpen, setRulesOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [freezeRows, setFreezeRows] = useState("0");
  const [freezeCols, setFreezeCols] = useState("0");
  const [formatCondition, setFormatCondition] = useState<
    "empty" | "not-empty" | "equals" | "contains" | "greater" | "less"
  >("not-empty");
  const [formatValue, setFormatValue] = useState("");
  const [formatColor, setFormatColor] = useState("#f59e0b");
  const [validationValues, setValidationValues] = useState("");
  const [scrollPosition, setScrollPosition] = useState({ left: 0, top: 0 });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey(documentId));
      if (!stored) return;
      const parsed = JSON.parse(stored) as {
        filter?: unknown;
        sort?: { colId?: unknown; direction?: unknown } | null;
      };
      if (typeof parsed.filter === "string") setFilter(parsed.filter);
      if (
        parsed.sort &&
        typeof parsed.sort.colId === "string" &&
        (parsed.sort.direction === "asc" || parsed.sort.direction === "desc")
      ) {
        setSort({ colId: parsed.sort.colId, direction: parsed.sort.direction });
      }
    } catch {
      localStorage.removeItem(storageKey(documentId));
    }
  }, [documentId]);

  useEffect(() => {
    localStorage.setItem(storageKey(documentId), JSON.stringify({ filter, sort }));
  }, [documentId, filter, sort]);

  useEffect(() => {
    if (!ydoc) return;
    const update = () => setRevision((value) => value + 1);
    ydoc.on("update", update);
    return () => ydoc.off("update", update);
  }, [ydoc]);

  useEffect(() => {
    if (!ydoc || readOnly) return;
    let recomputing = false;
    const recompute = (transaction: Y.Transaction) => {
      if (recomputing || transaction.origin === "formula") return;
      recomputing = true;
      try {
        recomputeFormulas(ydoc);
      } catch (error) {
        if (!(error instanceof SheetValidationError)) throw error;
      } finally {
        recomputing = false;
      }
    };
    ydoc.on("afterTransaction", recompute);
    try {
      recomputeFormulas(ydoc);
    } catch (error) {
      if (!(error instanceof SheetValidationError)) throw error;
    }
    return () => ydoc.off("afterTransaction", recompute);
  }, [ydoc, readOnly]);

  useEffect(() => {
    if (!awareness) return;
    const update = () => setRemoteRevision((value) => value + 1);
    awareness.on("change", update);
    return () => awareness.off("change", update);
  }, [awareness]);

  const model = useMemo(() => {
    void revision;
    if (!ydoc) return null;
    try {
      const inspection = inspectSheet(ydoc);
      const roots = getSheetRoots(ydoc);
      const naturalRows = inspection.rows;
      const cols = inspection.cols;
      let rows = naturalRows.filter((rowId) => {
        if (!filter.trim()) return true;
        const query = filter.toLocaleLowerCase();
        return cols.some((colId) =>
          displayedCellValue(readCell(roots, rowId, colId))
            .toLocaleLowerCase()
            .includes(query),
        );
      });
      if (sort && cols.includes(sort.colId)) {
        const naturalIndex = new Map(naturalRows.map((rowId, index) => [rowId, index]));
        rows = [...rows].sort((left, right) => {
          const leftCell = readCell(roots, left, sort.colId);
          const rightCell = readCell(roots, right, sort.colId);
          const leftValue = leftCell?.value ?? displayedCellValue(leftCell);
          const rightValue = rightCell?.value ?? displayedCellValue(rightCell);
          const compared =
            typeof leftValue === "number" && typeof rightValue === "number"
              ? leftValue - rightValue
              : String(leftValue ?? "").localeCompare(String(rightValue ?? ""), undefined, {
                  numeric: true,
                  sensitivity: "base",
                });
          if (compared !== 0) return sort.direction === "asc" ? compared : -compared;
          return (naturalIndex.get(left) ?? 0) - (naturalIndex.get(right) ?? 0);
        });
      }
      return {
        roots,
        rows,
        naturalRows,
        cols,
        formatRules: readFormatRules(roots),
        validationRules: readValidationRules(roots),
        rangeIndex: sheetRangeIndex(naturalRows, cols),
        settings: readSheetSettings(roots, naturalRows.length, cols.length),
      };
    } catch {
      return null;
    }
  }, [ydoc, revision, filter, sort]);

  useEffect(() => {
    if (!model) return;
    setSelection((current) => {
      if (
        current &&
        model.naturalRows.includes(current.anchor.rowId) &&
        model.naturalRows.includes(current.focus.rowId) &&
        model.cols.includes(current.anchor.colId) &&
        model.cols.includes(current.focus.colId)
      ) {
        return current;
      }
      const rowId = model.rows[0] ?? model.naturalRows[0];
      const colId = model.cols[0];
      return rowId && colId ? { anchor: { rowId, colId }, focus: { rowId, colId } } : null;
    });
  }, [model]);

  const active = selection?.focus ?? null;
  useEffect(() => {
    if (!active || !model) {
      onSelectionChange?.(null);
      return;
    }
    onSelectionChange?.({
      ...active,
      quote: displayedCellValue(readCell(model.roots, active.rowId, active.colId)),
    });
  }, [active, model, onSelectionChange]);

  useEffect(() => {
    awareness?.setLocalStateField(
      "sheetSelection",
      selection ? { anchor: selection.anchor, focus: selection.focus } : null,
    );
  }, [awareness, selection]);

  const undoManager = useMemo(() => {
    if (!ydoc) return null;
    const roots = getSheetRoots(ydoc);
    return new Y.UndoManager([roots.rows, roots.cols, roots.cells, roots.colMeta, roots.rowMeta], {
      captureTimeout: 400,
      trackedOrigins: new Set(["sheet-edit", "sheet-structure", "sheet-paste"]),
    });
  }, [ydoc]);
  useEffect(() => () => undoManager?.destroy(), [undoManager]);
  useEffect(() => {
    if (!undoManager) {
      setHistoryState({ canUndo: false, canRedo: false });
      return;
    }
    const update = () =>
      setHistoryState({
        canUndo: undoManager.undoStack.length > 0,
        canRedo: undoManager.redoStack.length > 0,
      });
    undoManager.on("stack-item-added", update);
    undoManager.on("stack-item-popped", update);
    undoManager.on("stack-cleared", update);
    undoManager.on("stack-item-updated", update);
    update();
    return () => {
      undoManager.off("stack-item-added", update);
      undoManager.off("stack-item-popped", update);
      undoManager.off("stack-cleared", update);
      undoManager.off("stack-item-updated", update);
    };
  }, [undoManager]);

  const rowVirtualizer = useVirtualizer({
    count: model?.rows.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      if (!model) return DEFAULT_ROW_HEIGHT;
      const rowId = model.rows[index];
      return Number((rowId && model.roots.rowMeta.get(rowId)?.get("height")) ?? DEFAULT_ROW_HEIGHT);
    },
    overscan: 8,
    rangeExtractor: (range) => [
      ...new Set([
        ...defaultRangeExtractor(range),
        ...Array.from({ length: model?.settings.frozenRows ?? 0 }, (_, index) => index),
      ]),
    ],
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: model?.cols.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      if (!model) return DEFAULT_COLUMN_WIDTH;
      const colId = model.cols[index];
      return Number(
        (colId && model.roots.colMeta.get(colId)?.get("width")) ?? DEFAULT_COLUMN_WIDTH,
      );
    },
    overscan: 3,
    rangeExtractor: (range) => [
      ...new Set([
        ...defaultRangeExtractor(range),
        ...Array.from({ length: model?.settings.frozenCols ?? 0 }, (_, index) => index),
      ]),
    ],
  });

  useEffect(() => {
    rowVirtualizer.measure();
    colVirtualizer.measure();
  }, [revision, rowVirtualizer, colVirtualizer]);

  const range = useMemo(() => {
    if (!selection || !model) return null;
    const rowA = model.rows.indexOf(selection.anchor.rowId);
    const rowB = model.rows.indexOf(selection.focus.rowId);
    const colA = model.cols.indexOf(selection.anchor.colId);
    const colB = model.cols.indexOf(selection.focus.colId);
    if (rowA < 0 || rowB < 0 || colA < 0 || colB < 0) return null;
    return {
      rowStart: Math.min(rowA, rowB),
      rowEnd: Math.max(rowA, rowB),
      colStart: Math.min(colA, colB),
      colEnd: Math.max(colA, colB),
    };
  }, [selection, model]);

  const selectAt = useCallback(
    (rowIndex: number, colIndex: number, extend = false) => {
      if (!model || model.rows.length === 0 || model.cols.length === 0) return;
      const row = Math.max(0, Math.min(model.rows.length - 1, rowIndex));
      const col = Math.max(0, Math.min(model.cols.length - 1, colIndex));
      const point = { rowId: itemAt(model.rows, row), colId: itemAt(model.cols, col) };
      setSelection((current) => ({
        anchor: extend && current ? current.anchor : point,
        focus: point,
      }));
      rowVirtualizer.scrollToIndex(row, { align: "auto" });
      colVirtualizer.scrollToIndex(col, { align: "auto" });
    },
    [model, rowVirtualizer, colVirtualizer],
  );

  const selectAll = useCallback(() => {
    if (!model || model.rows.length === 0 || model.cols.length === 0) return;
    setSelection({
      anchor: { rowId: itemAt(model.rows, 0), colId: itemAt(model.cols, 0) },
      focus: {
        rowId: itemAt(model.rows, model.rows.length - 1),
        colId: itemAt(model.cols, model.cols.length - 1),
      },
    });
  }, [model]);

  useEffect(() => {
    const finish = (event: PointerEvent) => {
      if (selectionDragRef.current?.pointerId === event.pointerId) {
        selectionDragRef.current = null;
      }
    };
    const move = (event: PointerEvent) => {
      const drag = selectionDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !model) return;
      if ((event.buttons & 1) === 0) {
        selectionDragRef.current = null;
        return;
      }
      event.preventDefault();
      const scroller = scrollRef.current;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const edge = 32;
        const horizontal =
          event.clientX < rect.left + edge ? -18 : event.clientX > rect.right - edge ? 18 : 0;
        const vertical =
          event.clientY < rect.top + edge ? -18 : event.clientY > rect.bottom - edge ? 18 : 0;
        if (horizontal || vertical) scroller.scrollBy(horizontal, vertical);
      }
      const cell = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-sheet-cell]");
      const rowIndex = Number(cell?.dataset.rowIndex);
      const colIndex = Number(cell?.dataset.colIndex);
      if (
        !cell ||
        !scrollRef.current?.contains(cell) ||
        !Number.isInteger(rowIndex) ||
        !Number.isInteger(colIndex) ||
        rowIndex < 0 ||
        colIndex < 0 ||
        rowIndex >= model.rows.length ||
        colIndex >= model.cols.length
      ) {
        return;
      }
      const focus = { rowId: itemAt(model.rows, rowIndex), colId: itemAt(model.cols, colIndex) };
      setSelection((current) =>
        current?.anchor.rowId === drag.anchor.rowId &&
        current.anchor.colId === drag.anchor.colId &&
        current.focus.rowId === focus.rowId &&
        current.focus.colId === focus.colId
          ? current
          : { anchor: drag.anchor, focus },
      );
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [model]);

  const beginEdit = useCallback(
    (seed?: string) => {
      if (readOnly || !active || !model) return;
      setDraft(
        seed ??
          cellInput(
            readCell(model.roots, active.rowId, active.colId),
            model.naturalRows,
            model.cols,
          ),
      );
      setEditing(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [readOnly, active, model],
  );

  const commitValue = useCallback(
    (raw: string, point: Point) => {
      if (!ydoc || !model || readOnly) return false;
      const current = readCell(model.roots, point.rowId, point.colId);
      if (raw === cellInput(current, model.naturalRows, model.cols)) return true;
      const validation = validationForCell(
        model.validationRules,
        model.rangeIndex,
        point.rowId,
        point.colId,
      );
      if (raw && !raw.startsWith("=") && validation) {
        const display = displayedCellValue(normalizeLiteral(raw));
        if (!validation.allowedValues.includes(display)) {
          notify.error("Value rejected", {
            description: `Choose one of: ${validation.allowedValues.join(", ")}`,
          });
          return false;
        }
      }
      try {
        ydoc.transact(() => {
          if (!raw) {
            setCell(model.roots, point.rowId, point.colId, null);
          } else if (raw.startsWith("=")) {
            const formula = formulaToInternal(raw, model.naturalRows, model.cols);
            setCell(model.roots, point.rowId, point.colId, {
              raw,
              type: "text",
              value: null,
              formula,
              display: "",
            });
          } else {
            setCell(model.roots, point.rowId, point.colId, normalizeLiteral(raw));
          }
          recomputeFormulas(ydoc);
        }, "sheet-edit");
        return true;
      } catch {
        notify.error("Invalid formula", {
          description: "Check the formula syntax and cell references.",
        });
        return false;
      }
    },
    [ydoc, model, readOnly],
  );

  const undo = useCallback(() => {
    if (!undoManager || readOnly) return;
    if (editing && active && model) {
      const current = cellInput(
        readCell(model.roots, active.rowId, active.colId),
        model.naturalRows,
        model.cols,
      );
      if (draft !== current) {
        setDraft(current);
        setEditing(false);
        requestAnimationFrame(() => scrollRef.current?.focus());
        return;
      }
    }
    setEditing(false);
    undoManager.undo();
    requestAnimationFrame(() => scrollRef.current?.focus());
  }, [undoManager, readOnly, editing, active, model, draft]);

  const redo = useCallback(() => {
    if (!undoManager || readOnly) return;
    setEditing(false);
    undoManager.redo();
    requestAnimationFrame(() => scrollRef.current?.focus());
  }, [undoManager, readOnly]);

  const finishEdit = (moveRow = 0, moveCol = 0) => {
    if (!active || !model || !commitValue(draft, active)) return;
    setEditing(false);
    selectAt(
      model.rows.indexOf(active.rowId) + moveRow,
      model.cols.indexOf(active.colId) + moveCol,
    );
  };

  const clearRange = useCallback(() => {
    if (!ydoc || !model || !range || readOnly) return;
    ydoc.transact(() => {
      for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
        for (let col = range.colStart; col <= range.colEnd; col += 1) {
          setCell(model.roots, itemAt(model.rows, row), itemAt(model.cols, col), null);
        }
      }
      recomputeFormulas(ydoc);
    }, "sheet-edit");
  }, [ydoc, model, range, readOnly]);

  const copyRange = useCallback(
    async (cut = false) => {
      if (!model || !range) return;
      const values: string[][] = [];
      for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
        values.push(
          model.cols
            .slice(range.colStart, range.colEnd + 1)
            .map((colId) =>
              displayedCellValue(readCell(model.roots, itemAt(model.rows, row), colId)),
            ),
        );
      }
      await navigator.clipboard.writeText(serializeDelimited(values, "\t", "\n"));
      if (cut) clearRange();
    },
    [model, range, clearRange],
  );

  const pasteText = useCallback(
    (text: string) => {
      if (!ydoc || !model || !active || readOnly) return;
      try {
        const values = parseDelimited(text, "\t");
        const rowStart = model.rows.indexOf(active.rowId);
        const colStart = model.cols.indexOf(active.colId);
        const width = Math.max(0, ...values.map((row) => row.length));
        if (rowStart + values.length > model.rows.length || colStart + width > model.cols.length) {
          notify.error("Paste rejected", {
            description:
              "The complete pasted range must fit in the sheet. Use file import for larger data.",
          });
          return;
        }
        let rejected = 0;
        const acceptedValues = values.map((row, rowOffset) =>
          row.map((raw, colOffset) => {
            if (!raw || raw.startsWith("=")) return raw;
            const rule = validationForCell(
              model.validationRules,
              model.rangeIndex,
              itemAt(model.rows, rowStart + rowOffset),
              itemAt(model.cols, colStart + colOffset),
            );
            if (!rule || rule.allowedValues.includes(displayedCellValue(normalizeLiteral(raw)))) {
              return raw;
            }
            rejected += 1;
            return "";
          }),
        );
        const preview = new Y.Doc();
        try {
          Y.applyUpdate(preview, Y.encodeStateAsUpdate(ydoc), "preview");
          const before = Y.encodeStateVector(preview);
          writePastedValues(
            preview,
            model.rows,
            model.naturalRows,
            model.cols,
            acceptedValues,
            rowStart,
            colStart,
          );
          const updateBytes = Y.encodeStateAsUpdate(preview, before).byteLength;
          if (updateBytes > MAX_SHEET_UPDATE_BYTES) {
            throw new Error(
              "This paste is too large for one collaborative update. Use file import instead.",
            );
          }
          const projectionBytes = new TextEncoder().encode(project("sheet", preview)).byteLength;
          if (
            projectionBytes > MAX_SHEET_PROJECTION_BYTES ||
            documentSize("sheet", preview) > MAX_SHEET_STORED_BYTES
          ) {
            throw new Error("This paste would exceed the spreadsheet file-size limit.");
          }
        } finally {
          preview.destroy();
        }
        writePastedValues(
          ydoc,
          model.rows,
          model.naturalRows,
          model.cols,
          acceptedValues,
          rowStart,
          colStart,
        );
        const nextFocus = {
          rowId: itemAt(model.rows, rowStart + values.length - 1),
          colId: itemAt(model.cols, colStart + width - 1),
        };
        setSelection({ anchor: active, focus: nextFocus });
        if (rejected > 0) {
          notify.warning("Some pasted cells were rejected", {
            description: `${rejected} ${rejected === 1 ? "value was" : "values were"} outside the allowed lists and left empty.`,
          });
        }
      } catch (error) {
        notify.error("Paste rejected", {
          description: error instanceof Error ? error.message : "The clipboard data is invalid.",
        });
      }
    },
    [ydoc, model, active, readOnly],
  );

  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!model || !active || editing) return;
    const row = model.rows.indexOf(active.rowId);
    const col = model.cols.indexOf(active.colId);
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
    } else if (command && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copyRange();
    } else if (command && event.key.toLowerCase() === "x" && !readOnly) {
      event.preventDefault();
      void copyRange(true);
    } else if (command && event.key.toLowerCase() === "v" && !readOnly) {
      event.preventDefault();
      void navigator.clipboard.readText().then(pasteText);
    } else if (command && event.key.toLowerCase() === "z" && !readOnly) {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (command && event.key.toLowerCase() === "y" && !readOnly) {
      event.preventDefault();
      redo();
    } else if (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight"
    ) {
      event.preventDefault();
      selectAt(
        row + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0),
        col + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0),
        event.shiftKey,
      );
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      beginEdit();
    } else if (event.key === "Tab") {
      event.preventDefault();
      selectAt(row, col + (event.shiftKey ? -1 : 1));
    } else if ((event.key === "Delete" || event.key === "Backspace") && !readOnly) {
      event.preventDefault();
      clearRange();
    } else if (!command && !event.altKey && event.key.length === 1 && !readOnly) {
      event.preventDefault();
      beginEdit(event.key);
    }
  };

  const structural = (kind: "row" | "col", action: "add" | "delete" | "before" | "after") => {
    if (!ydoc || !model || !active || readOnly || filter || sort) return;
    const array = kind === "row" ? model.roots.rows : model.roots.cols;
    const values = kind === "row" ? model.naturalRows : model.cols;
    const currentId = kind === "row" ? active.rowId : active.colId;
    const index = values.indexOf(currentId);
    ydoc.transact(() => {
      if (action === "add") {
        const newId = id();
        const nextRows = kind === "row" ? model.naturalRows.length + 1 : model.naturalRows.length;
        const nextCols = kind === "col" ? model.cols.length + 1 : model.cols.length;
        if (
          nextRows > MAX_SHEET_ROWS ||
          nextCols > MAX_SHEET_COLS ||
          nextRows * nextCols > MAX_SHEET_CELLS
        ) {
          throw new Error("too-many-cells");
        }
        array.insert(index + 1, [newId]);
        const meta = new Y.Map<unknown>();
        if (kind === "row") {
          meta.set("height", DEFAULT_ROW_HEIGHT);
          model.roots.rowMeta.set(newId, meta);
        } else {
          meta.set("width", DEFAULT_COLUMN_WIDTH);
          meta.set("name", columnLabel(index + 1));
          model.roots.colMeta.set(newId, meta);
        }
      } else if (action === "delete") {
        if (array.length <= 1) return;
        array.delete(index, 1);
      } else {
        const target = action === "before" ? index - 1 : index + 1;
        if (target < 0 || target >= values.length) return;
        array.delete(index, 1);
        array.insert(target, [currentId]);
      }
    }, "sheet-structure");
  };

  const resize = (kind: "row" | "col", targetId: string, delta: number) => {
    if (!ydoc || !model || readOnly) return;
    ydoc.transact(() => {
      const meta =
        kind === "row" ? model.roots.rowMeta.get(targetId) : model.roots.colMeta.get(targetId);
      if (!meta) return;
      const field = kind === "row" ? "height" : "width";
      const current = Number(meta.get(field));
      const min = kind === "row" ? MIN_ROW_HEIGHT : MIN_COLUMN_WIDTH;
      const max = kind === "row" ? MAX_ROW_HEIGHT : MAX_COLUMN_WIDTH;
      meta.set(field, Math.max(min, Math.min(max, current + delta)));
    }, "sheet-structure");
  };

  const beginResize = (
    event: React.PointerEvent<HTMLElement>,
    kind: "row" | "col",
    targetId: string,
  ) => {
    if (readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    resizedRef.current = true;
    setResizeTarget({ kind, id: targetId });
    let previous = kind === "col" ? event.clientX : event.clientY;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const next = kind === "col" ? moveEvent.clientX : moveEvent.clientY;
      resize(kind, targetId, next - previous);
      previous = next;
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      setResizeTarget(null);
      window.setTimeout(() => {
        resizedRef.current = false;
      }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const dropReorder = (kind: "row" | "col", movingId: string, targetId: string) => {
    if (!ydoc || !model || readOnly || !naturalView || movingId === targetId) return;
    const values = kind === "row" ? model.naturalRows : model.cols;
    const source = values.indexOf(movingId);
    const target = values.indexOf(targetId);
    if (source < 0 || target < 0) return;
    const array = kind === "row" ? model.roots.rows : model.roots.cols;
    ydoc.transact(() => {
      array.delete(source, 1);
      array.insert(target, [movingId]);
    }, "sheet-structure");
  };

  if (!model || model.naturalRows.length === 0 || model.cols.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Preparing spreadsheet…
      </div>
    );
  }

  const remoteSelections = [...(awareness?.getStates().entries() ?? [])]
    .filter(([clientId]) => clientId !== awareness?.clientID)
    .map(([, state]) => ({ state, selection: state.sheetSelection as Selection | undefined }))
    .flatMap(({ state, selection: value }) => {
      if (!value) return [];
      const anchorRow = model.rows.indexOf(value.anchor.rowId);
      const focusRow = model.rows.indexOf(value.focus.rowId);
      const anchorCol = model.cols.indexOf(value.anchor.colId);
      const focusCol = model.cols.indexOf(value.focus.colId);
      if (anchorRow < 0 || focusRow < 0 || anchorCol < 0 || focusCol < 0) return [];
      return [
        {
          state,
          focus: value.focus,
          rowStart: Math.min(anchorRow, focusRow),
          rowEnd: Math.max(anchorRow, focusRow),
          colStart: Math.min(anchorCol, focusCol),
          colEnd: Math.max(anchorCol, focusCol),
        },
      ];
    });
  void remoteRevision;

  const activeCell = active ? readCell(model.roots, active.rowId, active.colId) : null;
  const naturalView = !filter && !sort;
  const activeValidation = active
    ? validationForCell(model.validationRules, model.rangeIndex, active.rowId, active.colId)
    : null;
  const selectedRuleRange =
    range &&
    model.rows[range.rowStart] &&
    model.rows[range.rowEnd] &&
    model.cols[range.colStart] &&
    model.cols[range.colEnd]
      ? {
          startRowId: itemAt(model.rows, range.rowStart),
          endRowId: itemAt(model.rows, range.rowEnd),
          startColId: itemAt(model.cols, range.colStart),
          endColId: itemAt(model.cols, range.colEnd),
        }
      : null;

  const addFormatRule = () => {
    if (!selectedRuleRange || model.formatRules.length >= MAX_SHEET_FORMAT_RULES) return;
    const ruleId = id();
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(selectedRuleRange)) map.set(key, value);
    map.set("condition", formatCondition);
    map.set("value", formatValue.slice(0, 500));
    map.set("color", formatColor);
    map.set("enabled", true);
    ydoc?.transact(() => {
      model.roots.formatRules.set(ruleId, map);
      model.roots.formatRuleOrder.push([ruleId]);
    }, "sheet-format");
  };

  const addValidationRule = () => {
    const allowed = [
      ...new Set(
        validationValues
          .split(/[,\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].slice(0, 100);
    if (
      !selectedRuleRange ||
      allowed.length === 0 ||
      model.validationRules.length >= MAX_SHEET_VALIDATION_RULES
    )
      return;
    const ruleId = id();
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(selectedRuleRange)) map.set(key, value);
    const values = new Y.Array<string>();
    values.insert(0, allowed);
    map.set("allowedValues", values);
    ydoc?.transact(() => {
      model.roots.validationRules.set(ruleId, map);
      model.roots.validationRuleOrder.push([ruleId]);
    }, "sheet-format");
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Spreadsheet editor">
      <div className="sheet-toolbar">
        <div className="sheet-toolbar-actions" role="toolbar" aria-label="Spreadsheet actions">
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={undo}
            disabled={readOnly || !historyState.canUndo}
            className="sheet-tool"
            aria-label="Undo"
            aria-keyshortcuts="Control+Z Meta+Z"
          >
            <Undo2 />
          </button>
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={redo}
            disabled={readOnly || !historyState.canRedo}
            className="sheet-tool"
            aria-label="Redo"
            aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z"
          >
            <Redo2 />
          </button>
          <span className="mx-1 h-5 w-px bg-hairline" />
          <button
            type="button"
            onClick={() => structural("row", "add")}
            disabled={readOnly || !naturalView}
            className="sheet-tool-wide"
          >
            <Plus /> Row
          </button>
          <button
            type="button"
            onClick={() => structural("col", "add")}
            disabled={readOnly || !naturalView}
            className="sheet-tool-wide"
          >
            <Plus /> Column
          </button>
          <button
            type="button"
            onClick={() => structural("row", "delete")}
            disabled={readOnly || !naturalView}
            className="sheet-tool"
            aria-label="Delete row"
          >
            <Trash2 />
          </button>
          <button
            type="button"
            onClick={() => structural("col", "delete")}
            disabled={readOnly || !naturalView}
            className="sheet-tool"
            aria-label="Delete column"
          >
            <Trash2 className="rotate-90" />
          </button>
          <button
            type="button"
            onClick={() => structural("row", "before")}
            disabled={readOnly || !naturalView}
            className="sheet-tool"
            aria-label="Move row up"
          >
            <ArrowUp />
          </button>
          <button
            type="button"
            onClick={() => structural("row", "after")}
            disabled={readOnly || !naturalView}
            className="sheet-tool"
            aria-label="Move row down"
          >
            <ArrowDown />
          </button>
          <button
            type="button"
            onClick={() => structural("col", "before")}
            disabled={readOnly || !naturalView}
            className="sheet-tool"
            aria-label="Move column left"
          >
            <ArrowLeft />
          </button>
          <button
            type="button"
            onClick={() => structural("col", "after")}
            disabled={readOnly || !naturalView}
            className="sheet-tool"
            aria-label="Move column right"
          >
            <ArrowRight />
          </button>
          <button
            type="button"
            onClick={() => active && resize("row", active.rowId, 4)}
            disabled={readOnly}
            className="sheet-tool-wide sheet-tool-resize"
          >
            Taller row
          </button>
          <button
            type="button"
            onClick={() => active && resize("col", active.colId, 20)}
            disabled={readOnly}
            className="sheet-tool-wide sheet-tool-resize"
          >
            Wider column
          </button>
          {onAddComment ? (
            <button
              type="button"
              onClick={onAddComment}
              className="sheet-tool"
              aria-label="Comment on active cell"
            >
              <MessageSquarePlus />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setRulesOpen(true)}
            disabled={readOnly || !selectedRuleRange}
            className="sheet-tool-wide"
          >
            <Palette /> Rules
          </button>
          <button
            type="button"
            disabled={readOnly}
            onClick={() => {
              setFreezeRows(String(model.settings.frozenRows));
              setFreezeCols(String(model.settings.frozenCols));
              setFreezeOpen(true);
            }}
            className="sheet-tool-wide"
          >
            <Snowflake /> Freeze{" "}
            {model.settings.frozenRows || model.settings.frozenCols
              ? `${model.settings.frozenRows}×${model.settings.frozenCols}`
              : ""}
          </button>
        </div>
        <div className="sheet-toolbar-secondary">
          {onImportFile && !readOnly ? (
            <label className="sheet-tool-wide">
              <Upload /> Import
              <input
                type="file"
                accept=".csv,.tsv,.xlsx,.xls,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void onImportFile(file);
                }}
              />
            </label>
          ) : null}
          <label className="sheet-field sheet-filter-field h-8 px-2">
            <Filter className="size-3.5 text-muted-foreground" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter displayed values"
              className="sheet-field-input h-full min-w-0 flex-1 text-xs"
              aria-label="Filter displayed values"
            />
          </label>
        </div>
      </div>
      <div className="flex h-11 shrink-0 items-center gap-2 border-hairline border-b px-2">
        <span className="w-12 shrink-0 text-center font-mono text-muted-foreground text-xs leading-none">
          {active
            ? `${columnLabel(model.cols.indexOf(active.colId))}${model.naturalRows.indexOf(active.rowId) + 1}`
            : "—"}
        </span>
        <span className="font-mono text-muted-foreground text-xs leading-none">fx</span>
        <div className="sheet-field h-8 min-w-0 flex-1 px-2">
          {activeValidation && !editing ? (
            <select
              aria-label="Allowed cell value"
              disabled={readOnly}
              value={displayedCellValue(activeCell)}
              onChange={(event) => {
                if (active) commitValue(event.target.value, active);
              }}
              className="sheet-field-input h-full min-w-0 flex-1 text-sm"
            >
              <option value="">Choose a value</option>
              {activeValidation.allowedValues.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
              {displayedCellValue(activeCell) &&
              !activeValidation.allowedValues.includes(displayedCellValue(activeCell)) ? (
                <option value={displayedCellValue(activeCell)}>
                  Invalid: {displayedCellValue(activeCell)}
                </option>
              ) : null}
            </select>
          ) : (
            <input
              ref={inputRef}
              value={editing ? draft : cellInput(activeCell, model.naturalRows, model.cols)}
              readOnly={readOnly}
              onFocus={() => beginEdit()}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  finishEdit(1, 0);
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  finishEdit(0, event.shiftKey ? -1 : 1);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                  scrollRef.current?.focus();
                }
              }}
              onBlur={() => {
                if (editing && active) {
                  commitValue(draft, active);
                  setEditing(false);
                }
              }}
              className="sheet-field-input h-full min-w-0 flex-1 font-mono text-sm"
              aria-label="Formula bar"
            />
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        role="application"
        onKeyDown={keyDown}
        onScroll={(event) =>
          setScrollPosition({
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          })
        }
        onPaste={(event) => {
          if (!readOnly) {
            event.preventDefault();
            pasteText(event.clipboardData.getData("text/plain"));
          }
        }}
        className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <div
          style={{
            width: ROW_HEADER_WIDTH + colVirtualizer.getTotalSize(),
            height: HEADER_HEIGHT + rowVirtualizer.getTotalSize(),
          }}
          className="relative"
        >
          <button
            type="button"
            aria-label="Select all cells"
            title="Select all cells"
            onClick={() => {
              selectAll();
              scrollRef.current?.focus();
            }}
            className="sticky top-0 left-0 z-30 border-hairline border-r border-b bg-surface"
            style={{ width: ROW_HEADER_WIDTH, height: HEADER_HEIGHT }}
          />
          {colVirtualizer.getVirtualItems().map((virtualCol) => {
            const colId = itemAt(model.cols, virtualCol.index);
            const selected =
              range && virtualCol.index >= range.colStart && virtualCol.index <= range.colEnd;
            return (
              <button
                key={colId}
                type="button"
                draggable={!readOnly && naturalView}
                onDragStart={(event) => {
                  reorderedRef.current = true;
                  event.dataTransfer.setData("text/x-stash-sheet-col", colId);
                }}
                onDragEnd={() => {
                  window.setTimeout(() => {
                    reorderedRef.current = false;
                  }, 0);
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes("text/x-stash-sheet-col"))
                    event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  dropReorder("col", event.dataTransfer.getData("text/x-stash-sheet-col"), colId);
                }}
                onClick={() => {
                  if (resizedRef.current || reorderedRef.current) return;
                  const direction =
                    sort?.colId === colId && sort.direction === "asc" ? "desc" : "asc";
                  setSort({ colId, direction });
                }}
                className={cn(
                  "sticky top-0 z-20 border-hairline border-r border-b bg-surface font-mono text-xs",
                  selected && "bg-accent/10",
                )}
                style={{
                  position: "absolute",
                  left: 0,
                  transform: `translate(${ROW_HEADER_WIDTH + virtualCol.start + (virtualCol.index < model.settings.frozenCols ? scrollPosition.left : 0)}px, ${scrollPosition.top}px)`,
                  width: virtualCol.size,
                  height: HEADER_HEIGHT,
                  zIndex: virtualCol.index < model.settings.frozenCols ? 28 : 20,
                }}
                title="Sort this column"
              >
                {columnLabel(virtualCol.index)}
                {sort?.colId === colId ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
                {!readOnly ? (
                  <span
                    aria-hidden="true"
                    title="Drag to resize column"
                    className={cn(
                      "sheet-col-resize-handle",
                      resizeTarget?.kind === "col" && resizeTarget.id === colId && "is-resizing",
                    )}
                    onPointerDown={(event) => beginResize(event, "col", colId)}
                  />
                ) : null}
              </button>
            );
          })}
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const rowId = itemAt(model.rows, virtualRow.index);
            const canonicalRow = model.naturalRows.indexOf(rowId);
            return (
              <div
                key={rowId}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${HEADER_HEIGHT + virtualRow.start + (virtualRow.index < model.settings.frozenRows ? scrollPosition.top : 0)}px)`,
                  height: virtualRow.size,
                  width: ROW_HEADER_WIDTH + colVirtualizer.getTotalSize(),
                  zIndex: virtualRow.index < model.settings.frozenRows ? 8 : undefined,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (reorderedRef.current) return;
                    if (active)
                      setSelection({
                        anchor: { rowId, colId: itemAt(model.cols, 0) },
                        focus: { rowId, colId: itemAt(model.cols, model.cols.length - 1) },
                      });
                  }}
                  draggable={!readOnly && naturalView}
                  onDragStart={(event) => {
                    reorderedRef.current = true;
                    event.dataTransfer.setData("text/x-stash-sheet-row", rowId);
                  }}
                  onDragEnd={() => {
                    window.setTimeout(() => {
                      reorderedRef.current = false;
                    }, 0);
                  }}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes("text/x-stash-sheet-row"))
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropReorder("row", event.dataTransfer.getData("text/x-stash-sheet-row"), rowId);
                  }}
                  className="sticky left-0 z-10 border-hairline border-r border-b bg-surface font-mono text-[11px] text-muted-foreground"
                  style={{ width: ROW_HEADER_WIDTH, height: virtualRow.size }}
                >
                  {canonicalRow + 1}
                  {!readOnly ? (
                    <span
                      aria-hidden="true"
                      title="Drag to resize row"
                      className={cn(
                        "sheet-row-resize-handle",
                        resizeTarget?.kind === "row" && resizeTarget.id === rowId && "is-resizing",
                      )}
                      onPointerDown={(event) => beginResize(event, "row", rowId)}
                    />
                  ) : null}
                </button>
                {colVirtualizer.getVirtualItems().map((virtualCol) => {
                  const colId = itemAt(model.cols, virtualCol.index);
                  const cell = readCell(model.roots, rowId, colId);
                  const selected = Boolean(
                    range &&
                      virtualRow.index >= range.rowStart &&
                      virtualRow.index <= range.rowEnd &&
                      virtualCol.index >= range.colStart &&
                      virtualCol.index <= range.colEnd,
                  );
                  const focused = active?.rowId === rowId && active.colId === colId;
                  const remote = remoteSelections.find(
                    (value) =>
                      virtualRow.index >= value.rowStart &&
                      virtualRow.index <= value.rowEnd &&
                      virtualCol.index >= value.colStart &&
                      virtualCol.index <= value.colEnd,
                  );
                  const commented = activeComment?.rowId === rowId && activeComment.colId === colId;
                  const validation = validationForCell(
                    model.validationRules,
                    model.rangeIndex,
                    rowId,
                    colId,
                  );
                  const display = displayedCellValue(cell);
                  const invalid = Boolean(
                    validation && display && !validation.allowedValues.includes(display),
                  );
                  const formatColor = formatColorForCell(
                    model.formatRules,
                    model.rangeIndex,
                    rowId,
                    colId,
                    cell,
                  );
                  return (
                    <button
                      key={colId}
                      type="button"
                      data-sheet-cell="true"
                      data-row-index={virtualRow.index}
                      data-col-index={virtualCol.index}
                      tabIndex={focused ? 0 : -1}
                      aria-pressed={selected}
                      aria-label={`${columnLabel(virtualCol.index)}${canonicalRow + 1}: ${displayedCellValue(cell) || "empty"}`}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        const point = { rowId, colId };
                        const anchor = event.shiftKey && selection ? selection.anchor : point;
                        selectionDragRef.current = { pointerId: event.pointerId, anchor };
                        setSelection({ anchor, focus: point });
                        scrollRef.current?.focus();
                      }}
                      onDoubleClick={() => beginEdit()}
                      className={cn(
                        "absolute top-0 flex select-none items-center overflow-hidden border-hairline border-r border-b px-2 text-sm",
                        selected && "bg-accent/10",
                        focused && "z-[2] ring-2 ring-accent ring-inset",
                        commented &&
                          "after:absolute after:top-0 after:right-0 after:border-4 after:border-transparent after:border-t-warning after:border-r-warning",
                        invalid &&
                          "before:absolute before:top-0 before:left-0 before:border-4 before:border-transparent before:border-t-destructive before:border-l-destructive",
                      )}
                      style={{
                        left:
                          ROW_HEADER_WIDTH +
                          virtualCol.start +
                          (virtualCol.index < model.settings.frozenCols ? scrollPosition.left : 0),
                        width: virtualCol.size,
                        height: virtualRow.size,
                        backgroundColor: selected
                          ? undefined
                          : formatColor
                            ? `${formatColor}26`
                            : undefined,
                        zIndex:
                          virtualRow.index < model.settings.frozenRows ||
                          virtualCol.index < model.settings.frozenCols
                            ? 6
                            : undefined,
                        boxShadow: remote
                          ? `inset 0 0 0 2px ${remote.state.user?.color ?? "#1d4ed8"}`
                          : undefined,
                      }}
                    >
                      <span
                        className="truncate"
                        title={
                          invalid
                            ? `Invalid value. Allowed: ${validation?.allowedValues.join(", ")}`
                            : undefined
                        }
                      >
                        {display}
                      </span>
                      {remote?.focus.rowId === rowId && remote.focus.colId === colId ? (
                        <span
                          className="absolute top-0 right-0 max-w-24 truncate px-1 text-[9px] text-white"
                          style={{ backgroundColor: remote.state.user?.color ?? "#1d4ed8" }}
                        >
                          {remote.state.user?.name ?? "Collaborator"}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {!naturalView ? (
        <div className="shrink-0 border-hairline border-t bg-info/5 px-3 py-1.5 text-[11px] text-info">
          Canonical row numbers and A1 labels are preserved. Structural reorder is disabled until
          sort and filter are cleared.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setFilter("");
              setSort(null);
            }}
          >
            Restore natural view
          </button>
        </div>
      ) : null}
      <Dialog
        open={freezeOpen}
        onClose={() => setFreezeOpen(false)}
        title="Freeze panes"
        icon={<Snowflake className="size-4" />}
        description="Frozen leading rows and columns stay visible while the rest of the sheet scrolls."
        className="max-w-sm"
        mobileSheet
      >
        <form
          className="space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const rows = Number(freezeRows);
            const cols = Number(freezeCols);
            const maxRows = Math.min(20, model.naturalRows.length);
            const maxCols = Math.min(10, model.cols.length);
            if (
              !Number.isInteger(rows) ||
              !Number.isInteger(cols) ||
              rows < 0 ||
              rows > maxRows ||
              cols < 0 ||
              cols > maxCols
            ) {
              notify.error("Freeze not applied", {
                description: `Choose 0–${maxRows} rows and 0–${maxCols} columns.`,
              });
              return;
            }
            ydoc?.transact(() => {
              model.roots.settings.set("frozenRows", rows);
              model.roots.settings.set("frozenCols", cols);
            }, "sheet-format");
            setFreezeOpen(false);
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs">
              Frozen rows
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={Math.min(20, model.naturalRows.length)}
                value={freezeRows}
                onChange={(event) => setFreezeRows(event.target.value)}
                className="sheet-field mt-1 h-9 w-full px-2 text-xs"
              />
            </label>
            <label className="block text-xs">
              Frozen columns
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={Math.min(10, model.cols.length)}
                value={freezeCols}
                onChange={(event) => setFreezeCols(event.target.value)}
                className="sheet-field mt-1 h-9 w-full px-2 text-xs"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setFreezeOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        title="Format and validation rules"
        icon={<Palette className="size-4" />}
        description="Rules use stable row and column identities. Later formatting rules take precedence."
        className="max-w-2xl"
        mobileSheet
      >
        <div className="space-y-6 p-4">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium text-sm">Conditional formatting</h3>
              <span className="text-muted-foreground text-xs">
                {model.formatRules.length}/{MAX_SHEET_FORMAT_RULES}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
              <select
                value={formatCondition}
                onChange={(event) =>
                  setFormatCondition(event.target.value as typeof formatCondition)
                }
                className="sheet-field h-9 px-2 text-xs"
              >
                <option value="empty">Is empty</option>
                <option value="not-empty">Is not empty</option>
                <option value="equals">Equals</option>
                <option value="contains">Contains</option>
                <option value="greater">Greater than</option>
                <option value="less">Less than</option>
              </select>
              <input
                value={formatValue}
                onChange={(event) => setFormatValue(event.target.value)}
                disabled={formatCondition === "empty" || formatCondition === "not-empty"}
                className="sheet-field h-9 px-2 text-xs"
                placeholder="Comparison value"
              />
              <ColorPicker
                compact
                label="Rule color"
                value={formatColor}
                disabled={readOnly}
                onChange={setFormatColor}
              />
              <Button
                size="sm"
                disabled={
                  readOnly ||
                  !selectedRuleRange ||
                  model.formatRules.length >= MAX_SHEET_FORMAT_RULES
                }
                onClick={addFormatRule}
              >
                <Plus className="size-3.5" /> Add
              </Button>
            </div>
            <div className="space-y-2">
              {model.formatRules.map((rule, index) => (
                <div
                  key={rule.id}
                  className="flex items-center gap-2 rounded-md border border-hairline p-2 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={readOnly}
                    onChange={(event) =>
                      model.roots.formatRules.get(rule.id)?.set("enabled", event.target.checked)
                    }
                  />
                  <span className="size-4 rounded-sm" style={{ backgroundColor: rule.color }} />
                  <span className="min-w-0 flex-1 truncate">
                    {rule.condition}
                    {rule.value ? ` · ${rule.value}` : ""}
                  </span>
                  <button
                    type="button"
                    disabled={readOnly || index === 0}
                    onClick={() => {
                      const order = model.roots.formatRuleOrder;
                      order.delete(index, 1);
                      order.insert(index - 1, [rule.id]);
                    }}
                    className="sheet-tool"
                    aria-label="Move rule earlier"
                  >
                    <ArrowUp />
                  </button>
                  <button
                    type="button"
                    disabled={readOnly || index === model.formatRules.length - 1}
                    onClick={() => {
                      const order = model.roots.formatRuleOrder;
                      order.delete(index, 1);
                      order.insert(index + 1, [rule.id]);
                    }}
                    className="sheet-tool"
                    aria-label="Move rule later"
                  >
                    <ArrowDown />
                  </button>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => {
                      model.roots.formatRules.delete(rule.id);
                      model.roots.formatRuleOrder.delete(index, 1);
                    }}
                    className="sheet-tool"
                    aria-label="Remove rule"
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          </section>
          <section className="space-y-3 border-hairline border-t pt-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium text-sm">Allowed-value validation</h3>
              <span className="text-muted-foreground text-xs">
                {model.validationRules.length}/{MAX_SHEET_VALIDATION_RULES}
              </span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <textarea
                value={validationValues}
                onChange={(event) => setValidationValues(event.target.value)}
                className="sheet-field min-h-20 flex-1 p-2 text-xs"
                placeholder="Allowed values, separated by commas or lines"
              />
              <Button
                className="self-end"
                size="sm"
                disabled={
                  readOnly ||
                  !selectedRuleRange ||
                  !validationValues.trim() ||
                  model.validationRules.length >= MAX_SHEET_VALIDATION_RULES
                }
                onClick={addValidationRule}
              >
                <Plus className="size-3.5" /> Add validation
              </Button>
            </div>
            <div className="space-y-2">
              {model.validationRules.map((rule, index) => (
                <div
                  key={rule.id}
                  className="flex items-center gap-2 rounded-md border border-hairline p-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">{rule.allowedValues.join(" · ")}</span>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => {
                      model.roots.validationRules.delete(rule.id);
                      model.roots.validationRuleOrder.delete(index, 1);
                    }}
                    className="sheet-tool"
                    aria-label="Remove validation"
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </Dialog>
    </section>
  );
}
