import * as Y from "yjs";

export const MAX_BOARD_COLUMNS = 100;
export const MAX_BOARD_CARDS = 2_000;
export const MAX_BOARD_LABELS = 100;
export const MAX_CARD_CHECKLIST_ITEMS = 100;
export const MAX_BOARD_STORED_BYTES = 896 * 1024;
export const UNFILED_COLUMN_ID = "unfiled";
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 64 * 1024;
const MAX_LABEL_NAME_LENGTH = 80;

const BOARD_COLOR_PALETTE = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
] as const;

export type BoardPriority = "low" | "medium" | "high" | "critical";

export type BoardRoots = {
  columns: Y.Array<string>;
  columnMeta: Y.Map<Y.Map<unknown>>;
  cardOrder: Y.Map<Y.Array<string>>;
  cards: Y.Map<Y.Map<unknown>>;
  labelMeta: Y.Map<Y.Map<unknown>>;
  settings: Y.Map<unknown>;
};

type BoardLaneMode = "none" | "assignee" | "label";

type BoardChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

export type BoardSettings = {
  laneMode: BoardLaneMode;
  enforceWipLimits: boolean;
};

export type BoardCard = {
  id: string;
  title: string;
  description: string;
  descriptionText: Y.Text;
  assignees: string[];
  labels: string[];
  due: number | null;
  linkedDocId: string | null;
  columnId: string;
  color: string;
  priority: BoardPriority | null;
  checklist: BoardChecklistItem[];
};

export type BoardInspection = {
  columns: string[];
  columnSet: Set<string>;
  cards: Map<string, BoardCard>;
  dimensions: { columns: number; cards: number };
};

export class BoardValidationError extends Error {
  constructor(public readonly code: "invalid-update" | "too-many-cards") {
    super(code);
  }
}

export function boardId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function boardColor(index: number): string {
  return BOARD_COLOR_PALETTE[Math.abs(index) % BOARD_COLOR_PALETTE.length] ?? "#3b82f6";
}

export function boardColorForId(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return boardColor(hash);
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function isBoardId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function uniqueIds(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isBoardId(value)) throw new BoardValidationError("invalid-update");
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function getBoardRoots(ydoc: Y.Doc): BoardRoots {
  return {
    columns: ydoc.getArray<string>("columns"),
    columnMeta: ydoc.getMap<Y.Map<unknown>>("columnMeta"),
    cardOrder: ydoc.getMap<Y.Array<string>>("cardOrder"),
    cards: ydoc.getMap<Y.Map<unknown>>("cards"),
    labelMeta: ydoc.getMap<Y.Map<unknown>>("labelMeta"),
    settings: ydoc.getMap("boardSettings"),
  };
}

export function seedBoard(ydoc: Y.Doc, idFactory: () => string = boardId): BoardInspection {
  const roots = getBoardRoots(ydoc);
  if (roots.columns.length > 0) return inspectBoard(ydoc);
  const columns = ["To do", "In progress", "Done"].map((name, index) => ({
    id: idFactory(),
    name,
    color: boardColor(index),
  }));
  ydoc.transact(() => {
    roots.columns.insert(
      0,
      columns.map((column) => column.id),
    );
    for (const column of columns) {
      const meta = new Y.Map<unknown>();
      meta.set("name", column.name);
      meta.set("color", column.color);
      roots.columnMeta.set(column.id, meta);
      roots.cardOrder.set(column.id, new Y.Array<string>());
    }
    roots.cardOrder.set(UNFILED_COLUMN_ID, new Y.Array<string>());
  }, "seed");
  return inspectBoard(ydoc);
}

function stringArray(value: unknown, maximum: number): string[] {
  if (!(value instanceof Y.Array)) throw new BoardValidationError("invalid-update");
  const ids = uniqueIds(value.toArray());
  if (ids.length > maximum) throw new BoardValidationError("invalid-update");
  return ids;
}

function readBoardCard(id: string, value: Y.Map<unknown>): BoardCard {
  const fields = new Set([
    "title",
    "description",
    "assignees",
    "labels",
    "due",
    "linkedDocId",
    "columnId",
    "color",
    "priority",
    "checklist",
  ]);
  if ([...value.keys()].some((key) => !fields.has(key))) {
    throw new BoardValidationError("invalid-update");
  }
  const title = value.get("title");
  const descriptionText = value.get("description");
  const assigneesValue = value.get("assignees");
  const labelsValue = value.get("labels");
  const due = value.get("due");
  const linkedDocId = value.get("linkedDocId");
  const columnId = value.get("columnId");
  const colorValue = value.get("color");
  const priorityValue = value.get("priority");
  const checklistValue = value.get("checklist");
  const color = colorValue === undefined ? "#64748b" : colorValue;
  const priority = priorityValue === undefined ? null : priorityValue;
  if (
    !isBoardId(id) ||
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.length > MAX_TITLE_LENGTH ||
    !(descriptionText instanceof Y.Text) ||
    descriptionText.length > MAX_DESCRIPTION_LENGTH ||
    descriptionText
      .toDelta()
      .some(
        (part: { insert: unknown; attributes?: unknown }) =>
          typeof part.insert !== "string" || Boolean(part.attributes),
      ) ||
    !(assigneesValue instanceof Y.Array) ||
    !(labelsValue instanceof Y.Array) ||
    !(
      due === null ||
      (typeof due === "number" && Number.isFinite(due) && due >= 0 && due <= 8_640_000_000_000_000)
    ) ||
    !(linkedDocId === null || isBoardId(linkedDocId)) ||
    !isBoardId(columnId) ||
    !isColor(color) ||
    !(priority === null || ["low", "medium", "high", "critical"].includes(String(priority))) ||
    !(checklistValue === undefined || checklistValue instanceof Y.Array)
  ) {
    throw new BoardValidationError("invalid-update");
  }
  const checklist = checklistValue ? readChecklist(checklistValue as Y.Array<unknown>) : [];
  return {
    id,
    title,
    description: descriptionText.toString(),
    descriptionText,
    assignees: stringArray(assigneesValue, 100),
    labels: stringArray(labelsValue, MAX_BOARD_LABELS),
    due,
    linkedDocId,
    columnId,
    color,
    priority: priority as BoardPriority | null,
    checklist,
  };
}

function readChecklist(value: Y.Array<unknown>): BoardChecklistItem[] {
  if (value.length > MAX_CARD_CHECKLIST_ITEMS) throw new BoardValidationError("invalid-update");
  const seen = new Set<string>();
  return value.toArray().map((entry) => {
    if (!(entry instanceof Y.Map)) throw new BoardValidationError("invalid-update");
    const id = entry.get("id");
    const text = entry.get("text");
    const done = entry.get("done");
    if (
      !isBoardId(id) ||
      seen.has(id) ||
      typeof text !== "string" ||
      text.trim().length === 0 ||
      text.length > 500 ||
      typeof done !== "boolean" ||
      [...entry.keys()].some((key) => key !== "id" && key !== "text" && key !== "done")
    ) {
      throw new BoardValidationError("invalid-update");
    }
    seen.add(id);
    return { id, text, done };
  });
}

export function readBoardSettings(roots: BoardRoots): BoardSettings {
  const laneMode = roots.settings.get("laneMode") ?? "none";
  const enforceWipLimits = roots.settings.get("enforceWipLimits") ?? false;
  if (
    !["none", "assignee", "label"].includes(String(laneMode)) ||
    typeof enforceWipLimits !== "boolean" ||
    [...roots.settings.keys()].some((key) => key !== "laneMode" && key !== "enforceWipLimits")
  ) {
    throw new BoardValidationError("invalid-update");
  }
  return { laneMode: laneMode as BoardLaneMode, enforceWipLimits };
}

export function columnWipLimit(roots: BoardRoots, columnId: string): number | null {
  const raw = roots.columnMeta.get(columnId)?.get("wipLimit");
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || Number(raw) < 1 || Number(raw) > MAX_BOARD_CARDS) {
    throw new BoardValidationError("invalid-update");
  }
  return Number(raw);
}

export function inspectBoard(ydoc: Y.Doc): BoardInspection {
  const roots = getBoardRoots(ydoc);
  if (roots.columns.length > MAX_BOARD_COLUMNS * 4) {
    throw new BoardValidationError("too-many-cards");
  }
  const columns = uniqueIds(roots.columns.toArray());
  if (columns.length > MAX_BOARD_COLUMNS || roots.cards.size > MAX_BOARD_CARDS) {
    throw new BoardValidationError("too-many-cards");
  }
  const columnSet = new Set(columns);
  for (const [id, meta] of roots.columnMeta.entries()) {
    if (!isBoardId(id) || !(meta instanceof Y.Map))
      throw new BoardValidationError("invalid-update");
    const name = meta.get("name");
    const color = meta.get("color");
    if (
      [...meta.keys()].some((key) => key !== "name" && key !== "color" && key !== "wipLimit") ||
      typeof name !== "string" ||
      name.trim().length === 0 ||
      name.length > 120 ||
      !(color === undefined || isColor(color))
    ) {
      throw new BoardValidationError("invalid-update");
    }
    columnWipLimit(roots, id);
  }
  if (columns.some((id) => !roots.columnMeta.has(id) || !roots.cardOrder.has(id))) {
    throw new BoardValidationError("invalid-update");
  }
  if (!roots.cardOrder.has(UNFILED_COLUMN_ID)) throw new BoardValidationError("invalid-update");
  let orderedEntries = 0;
  for (const [id, order] of roots.cardOrder.entries()) {
    if (!isBoardId(id) || !(order instanceof Y.Array))
      throw new BoardValidationError("invalid-update");
    orderedEntries += order.length;
    if (orderedEntries > MAX_BOARD_CARDS * 4) {
      throw new BoardValidationError("too-many-cards");
    }
    for (const cardId of order.toArray()) {
      if (!isBoardId(cardId)) throw new BoardValidationError("invalid-update");
    }
  }
  const cards = new Map<string, BoardCard>();
  for (const [id, card] of roots.cards.entries()) {
    if (!(card instanceof Y.Map)) throw new BoardValidationError("invalid-update");
    cards.set(id, readBoardCard(id, card));
  }
  if (roots.labelMeta.size > MAX_BOARD_LABELS) throw new BoardValidationError("invalid-update");
  for (const [id, meta] of roots.labelMeta.entries()) {
    if (!isBoardId(id) || !(meta instanceof Y.Map))
      throw new BoardValidationError("invalid-update");
    const name = meta.get("name");
    const color = meta.get("color");
    if (
      [...meta.keys()].some((key) => key !== "name" && key !== "color") ||
      typeof name !== "string" ||
      name.trim().length === 0 ||
      name.length > MAX_LABEL_NAME_LENGTH ||
      typeof color !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(color)
    ) {
      throw new BoardValidationError("invalid-update");
    }
  }
  readBoardSettings(roots);
  return { columns, columnSet, cards, dimensions: { columns: columns.length, cards: cards.size } };
}

export function createBoardCard(
  columnId: string,
  title: string,
  color = "#3b82f6",
): Y.Map<unknown> {
  const card = new Y.Map<unknown>();
  card.set("title", title.trim().slice(0, MAX_TITLE_LENGTH));
  card.set("description", new Y.Text());
  card.set("assignees", new Y.Array<string>());
  card.set("labels", new Y.Array<string>());
  card.set("due", null);
  card.set("linkedDocId", null);
  card.set("columnId", columnId);
  card.set("color", color);
  card.set("priority", null);
  card.set("checklist", new Y.Array<Y.Map<unknown>>());
  return card;
}

export function createChecklistItem(text: string, itemId = boardId()): Y.Map<unknown> {
  const item = new Y.Map<unknown>();
  item.set("id", itemId);
  item.set("text", text.trim().slice(0, 500));
  item.set("done", false);
  return item;
}

export function orderedCards(
  roots: BoardRoots,
  inspection: BoardInspection,
  columnId: string,
): BoardCard[] {
  const order = roots.cardOrder.get(columnId)?.toArray() ?? [];
  const seen = new Set<string>();
  const result: BoardCard[] = [];
  const belongs = (card: BoardCard) =>
    card.columnId === columnId ||
    (columnId === UNFILED_COLUMN_ID && !inspection.columnSet.has(card.columnId));
  for (const cardId of order) {
    const card = inspection.cards.get(cardId);
    if (card && belongs(card) && !seen.has(cardId)) {
      seen.add(cardId);
      result.push(card);
    }
  }
  for (const card of inspection.cards.values()) {
    if (belongs(card) && !seen.has(card.id)) result.push(card);
  }
  return result;
}
