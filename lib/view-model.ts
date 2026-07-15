import * as Y from "yjs";

const VIEW_LAYOUTS = ["table", "board", "timeline", "calendar"] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];

export const BUILTIN_VIEW_PROPERTIES = ["title", "fileType", "updatedAt"] as const;

const MAX_VIEW_COLUMNS = 32;
const MAX_VIEW_FILTERS = 16;
const MAX_VIEW_SORTS = 8;
export const MAX_VIEW_STATE_BYTES = 192 * 1024;
export const MAX_VIEW_STORED_BYTES = 256 * 1024;

export type ViewFilterOperator =
  | "contains"
  | "equals"
  | "not-equals"
  | "is-empty"
  | "is-not-empty"
  | "before"
  | "after";

export type ViewFilter = {
  id: string;
  propertyId: string;
  operator: ViewFilterOperator;
  value: string;
};

type ViewSort = {
  id: string;
  propertyId: string;
  direction: "asc" | "desc";
};

export type ViewConfig = {
  layout: ViewLayout;
  visibleColumns: string[];
  groupBy: string | null;
  datePropertyId: string | null;
  filters: ViewFilter[];
  sorts: ViewSort[];
};

export type ViewRoots = {
  config: Y.Map<unknown>;
  visibleColumns: Y.Array<string>;
  filters: Y.Map<Y.Map<unknown>>;
  filterOrder: Y.Array<string>;
  sorts: Y.Map<Y.Map<unknown>>;
  sortOrder: Y.Array<string>;
};

export class ViewValidationError extends Error {
  constructor() {
    super("invalid-update");
    this.name = "ViewValidationError";
  }
}

export function viewId(): string {
  return crypto.randomUUID();
}

export function getViewRoots(ydoc: Y.Doc): ViewRoots {
  return {
    config: ydoc.getMap("viewConfig"),
    visibleColumns: ydoc.getArray("viewColumns"),
    filters: ydoc.getMap("viewFilters"),
    filterOrder: ydoc.getArray("viewFilterOrder"),
    sorts: ydoc.getMap("viewSorts"),
    sortOrder: ydoc.getArray("viewSortOrder"),
  };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function uniqueIds(values: unknown[], cap: number): string[] {
  if (values.length > cap * 4) throw new ViewValidationError();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isId(value)) throw new ViewValidationError();
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  if (result.length > cap) throw new ViewValidationError();
  return result;
}

function stringField(map: Y.Map<unknown>, key: string, max: number): string {
  const value = map.get(key);
  if (typeof value !== "string" || value.length > max) throw new ViewValidationError();
  return value;
}

export function inspectView(ydoc: Y.Doc): ViewConfig {
  const roots = getViewRoots(ydoc);
  const layout = roots.config.get("layout");
  const groupBy = roots.config.get("groupBy");
  const datePropertyId = roots.config.get("datePropertyId");
  if (
    !VIEW_LAYOUTS.includes(layout as ViewLayout) ||
    !(groupBy === null || isId(groupBy)) ||
    !(datePropertyId === null || isId(datePropertyId)) ||
    [...roots.config.keys()].some(
      (key) => key !== "layout" && key !== "groupBy" && key !== "datePropertyId",
    )
  ) {
    throw new ViewValidationError();
  }
  const visibleColumns = uniqueIds(roots.visibleColumns.toArray(), MAX_VIEW_COLUMNS);
  const filterOrder = uniqueIds(roots.filterOrder.toArray(), MAX_VIEW_FILTERS);
  const sortOrder = uniqueIds(roots.sortOrder.toArray(), MAX_VIEW_SORTS);
  if (roots.filters.size > MAX_VIEW_FILTERS || roots.sorts.size > MAX_VIEW_SORTS) {
    throw new ViewValidationError();
  }
  const filters = filterOrder.map((id) => {
    const filter = roots.filters.get(id);
    if (!(filter instanceof Y.Map)) throw new ViewValidationError();
    const propertyId = stringField(filter, "propertyId", 128);
    const operator = stringField(filter, "operator", 32) as ViewFilterOperator;
    const value = stringField(filter, "value", 500);
    if (
      !["contains", "equals", "not-equals", "is-empty", "is-not-empty", "before", "after"].includes(
        operator,
      ) ||
      [...filter.keys()].some(
        (key) => key !== "propertyId" && key !== "operator" && key !== "value",
      )
    ) {
      throw new ViewValidationError();
    }
    return { id, propertyId, operator, value };
  });
  const sorts = sortOrder.map((id) => {
    const sort = roots.sorts.get(id);
    if (!(sort instanceof Y.Map)) throw new ViewValidationError();
    const propertyId = stringField(sort, "propertyId", 128);
    const direction = stringField(sort, "direction", 4);
    if (
      (direction !== "asc" && direction !== "desc") ||
      [...sort.keys()].some((key) => key !== "propertyId" && key !== "direction")
    ) {
      throw new ViewValidationError();
    }
    return { id, propertyId, direction: direction as "asc" | "desc" };
  });
  return {
    layout: layout as ViewLayout,
    visibleColumns,
    groupBy: groupBy as string | null,
    datePropertyId: datePropertyId as string | null,
    filters,
    sorts,
  };
}

export function seedView(ydoc: Y.Doc): void {
  const roots = getViewRoots(ydoc);
  if (roots.config.has("layout")) return;
  ydoc.transact(() => {
    roots.config.set("layout", "table");
    roots.config.set("groupBy", null);
    roots.config.set("datePropertyId", "updatedAt");
    roots.visibleColumns.insert(0, [...BUILTIN_VIEW_PROPERTIES]);
  }, "seed");
}

export function replaceViewState(current: Y.Doc, target: Y.Doc): void {
  const currentRoots = getViewRoots(current);
  const targetConfig = inspectView(target);
  current.transact(() => {
    for (const key of [...currentRoots.config.keys()]) currentRoots.config.delete(key);
    currentRoots.config.set("layout", targetConfig.layout);
    currentRoots.config.set("groupBy", targetConfig.groupBy);
    currentRoots.config.set("datePropertyId", targetConfig.datePropertyId);
    currentRoots.visibleColumns.delete(0, currentRoots.visibleColumns.length);
    currentRoots.visibleColumns.insert(0, targetConfig.visibleColumns);
    for (const key of [...currentRoots.filters.keys()]) currentRoots.filters.delete(key);
    currentRoots.filterOrder.delete(0, currentRoots.filterOrder.length);
    for (const filter of targetConfig.filters) {
      const map = new Y.Map<unknown>();
      map.set("propertyId", filter.propertyId);
      map.set("operator", filter.operator);
      map.set("value", filter.value);
      currentRoots.filters.set(filter.id, map);
    }
    currentRoots.filterOrder.insert(
      0,
      targetConfig.filters.map((filter) => filter.id),
    );
    for (const key of [...currentRoots.sorts.keys()]) currentRoots.sorts.delete(key);
    currentRoots.sortOrder.delete(0, currentRoots.sortOrder.length);
    for (const sort of targetConfig.sorts) {
      const map = new Y.Map<unknown>();
      map.set("propertyId", sort.propertyId);
      map.set("direction", sort.direction);
      currentRoots.sorts.set(sort.id, map);
    }
    currentRoots.sortOrder.insert(
      0,
      targetConfig.sorts.map((sort) => sort.id),
    );
  }, "replace-view");
}
