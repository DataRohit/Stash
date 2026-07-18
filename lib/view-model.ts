import * as Y from "yjs";

const VIEW_LAYOUTS = ["table", "board", "timeline", "calendar", "gallery"] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];

export const BUILTIN_VIEW_PROPERTIES = ["title", "fileType", "updatedAt"] as const;

const MAX_VIEW_COLUMNS = 32;
const MAX_VIEW_FILTERS = 16;
const MAX_VIEW_SORTS = 8;
const MAX_SAVED_VIEW_LAYOUTS = 24;
export const MAX_VIEW_STATE_BYTES = 192 * 1024;
export const MAX_VIEW_STORED_BYTES = 256 * 1024;

const FILTER_OPERATORS = [
  "contains",
  "equals",
  "not-equals",
  "is-empty",
  "is-not-empty",
  "before",
  "after",
] as const;

export type ViewFilterOperator = (typeof FILTER_OPERATORS)[number];

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
  coverPropertyId: string | null;
};

export type SavedViewLayout = ViewConfig & {
  id: string;
  name: string;
};

export type ViewRoots = {
  config: Y.Map<unknown>;
  visibleColumns: Y.Array<string>;
  filters: Y.Map<Y.Map<unknown>>;
  filterOrder: Y.Array<string>;
  sorts: Y.Map<Y.Map<unknown>>;
  sortOrder: Y.Array<string>;
  savedLayouts: Y.Map<Y.Map<unknown>>;
  savedLayoutOrder: Y.Array<string>;
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
    savedLayouts: ydoc.getMap("viewSavedLayouts"),
    savedLayoutOrder: ydoc.getArray("viewSavedLayoutOrder"),
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
  const coverPropertyId = roots.config.get("coverPropertyId") ?? null;
  if (
    !VIEW_LAYOUTS.includes(layout as ViewLayout) ||
    !(groupBy === null || isId(groupBy)) ||
    !(datePropertyId === null || isId(datePropertyId)) ||
    !(coverPropertyId === null || isId(coverPropertyId)) ||
    [...roots.config.keys()].some(
      (key) =>
        key !== "layout" &&
        key !== "groupBy" &&
        key !== "datePropertyId" &&
        key !== "coverPropertyId",
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
      !FILTER_OPERATORS.includes(operator) ||
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
  inspectSavedLayouts(ydoc);
  return {
    layout: layout as ViewLayout,
    visibleColumns,
    groupBy: groupBy as string | null,
    datePropertyId: datePropertyId as string | null,
    filters,
    sorts,
    coverPropertyId: coverPropertyId as string | null,
  };
}

function parseSavedLayout(id: string, map: Y.Map<unknown>): SavedViewLayout {
  const name = map.get("name");
  const raw = map.get("config");
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.length > 80 ||
    typeof raw !== "string" ||
    raw.length > 32_000 ||
    [...map.keys()].some((key) => key !== "name" && key !== "config")
  ) {
    throw new ViewValidationError();
  }
  let config: ViewConfig;
  try {
    config = JSON.parse(raw) as ViewConfig;
  } catch {
    throw new ViewValidationError();
  }
  if (
    !VIEW_LAYOUTS.includes(config.layout) ||
    !Array.isArray(config.visibleColumns) ||
    config.visibleColumns.length > MAX_VIEW_COLUMNS ||
    !Array.isArray(config.filters) ||
    config.filters.length > MAX_VIEW_FILTERS ||
    !Array.isArray(config.sorts) ||
    config.sorts.length > MAX_VIEW_SORTS ||
    !(config.groupBy === null || isId(config.groupBy)) ||
    !(config.datePropertyId === null || isId(config.datePropertyId)) ||
    !(config.coverPropertyId === null || isId(config.coverPropertyId))
  ) {
    throw new ViewValidationError();
  }
  return { ...config, id, name };
}

export function inspectSavedLayouts(ydoc: Y.Doc): SavedViewLayout[] {
  const roots = getViewRoots(ydoc);
  const order = uniqueIds(roots.savedLayoutOrder.toArray(), MAX_SAVED_VIEW_LAYOUTS);
  if (
    roots.savedLayouts.size > MAX_SAVED_VIEW_LAYOUTS ||
    order.length !== roots.savedLayouts.size
  ) {
    throw new ViewValidationError();
  }
  return order.map((id) => {
    const map = roots.savedLayouts.get(id);
    if (!map) throw new ViewValidationError();
    return parseSavedLayout(id, map);
  });
}

export function saveCurrentViewLayout(ydoc: Y.Doc, name: string, layoutId = viewId()): string {
  const roots = getViewRoots(ydoc);
  const config = inspectView(ydoc);
  const layouts = inspectSavedLayouts(ydoc);
  if (!roots.savedLayouts.has(layoutId) && layouts.length >= MAX_SAVED_VIEW_LAYOUTS) {
    throw new ViewValidationError();
  }
  ydoc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("name", name.trim().slice(0, 80));
    map.set("config", JSON.stringify(config));
    roots.savedLayouts.set(layoutId, map);
    if (!roots.savedLayoutOrder.toArray().includes(layoutId)) {
      roots.savedLayoutOrder.push([layoutId]);
    }
  }, "view-layout");
  return layoutId;
}

function normalizeViewConfig(candidate: unknown): ViewConfig {
  const source = candidate as Partial<ViewConfig> | null;
  if (!source || typeof source !== "object") throw new ViewValidationError();
  const visibleColumns = uniqueIds(
    Array.isArray(source.visibleColumns) ? source.visibleColumns : [],
    MAX_VIEW_COLUMNS,
  );
  const filters = (Array.isArray(source.filters) ? source.filters : [])
    .slice(0, MAX_VIEW_FILTERS)
    .map((filter) => {
      if (
        !filter ||
        !isId(filter.propertyId) ||
        !FILTER_OPERATORS.includes(filter.operator) ||
        typeof filter.value !== "string" ||
        filter.value.length > 200
      ) {
        throw new ViewValidationError();
      }
      return {
        id: isId(filter.id) ? filter.id : viewId(),
        propertyId: filter.propertyId,
        operator: filter.operator,
        value: filter.value,
      };
    });
  const sorts = (Array.isArray(source.sorts) ? source.sorts : [])
    .slice(0, MAX_VIEW_SORTS)
    .map((sort) => {
      if (
        !sort ||
        !isId(sort.propertyId) ||
        (sort.direction !== "asc" && sort.direction !== "desc")
      ) {
        throw new ViewValidationError();
      }
      return {
        id: isId(sort.id) ? sort.id : viewId(),
        propertyId: sort.propertyId,
        direction: sort.direction,
      };
    });
  if (
    !VIEW_LAYOUTS.includes(source.layout as ViewLayout) ||
    !(source.groupBy == null || isId(source.groupBy)) ||
    !(source.datePropertyId == null || isId(source.datePropertyId)) ||
    !(source.coverPropertyId == null || isId(source.coverPropertyId))
  ) {
    throw new ViewValidationError();
  }
  return {
    layout: source.layout as ViewLayout,
    visibleColumns,
    groupBy: source.groupBy ?? null,
    datePropertyId: source.datePropertyId ?? null,
    coverPropertyId: source.coverPropertyId ?? null,
    filters,
    sorts,
  };
}

export function applyViewConfig(ydoc: Y.Doc, candidate: unknown): void {
  const config = normalizeViewConfig(candidate);
  const roots = getViewRoots(ydoc);
  ydoc.transact(() => {
    roots.config.set("layout", config.layout);
    roots.config.set("groupBy", config.groupBy);
    roots.config.set("datePropertyId", config.datePropertyId);
    roots.config.set("coverPropertyId", config.coverPropertyId);
    roots.visibleColumns.delete(0, roots.visibleColumns.length);
    roots.visibleColumns.insert(0, config.visibleColumns);
    for (const key of [...roots.filters.keys()]) roots.filters.delete(key);
    roots.filterOrder.delete(0, roots.filterOrder.length);
    for (const filter of config.filters) {
      const map = new Y.Map<unknown>();
      map.set("propertyId", filter.propertyId);
      map.set("operator", filter.operator);
      map.set("value", filter.value);
      roots.filters.set(filter.id, map);
    }
    roots.filterOrder.insert(
      0,
      config.filters.map((filter) => filter.id),
    );
    for (const key of [...roots.sorts.keys()]) roots.sorts.delete(key);
    roots.sortOrder.delete(0, roots.sortOrder.length);
    for (const sort of config.sorts) {
      const map = new Y.Map<unknown>();
      map.set("propertyId", sort.propertyId);
      map.set("direction", sort.direction);
      roots.sorts.set(sort.id, map);
    }
    roots.sortOrder.insert(
      0,
      config.sorts.map((sort) => sort.id),
    );
  }, "view-layout");
}

export function applySavedViewLayout(ydoc: Y.Doc, layoutId: string): void {
  const layout = inspectSavedLayouts(ydoc).find((candidate) => candidate.id === layoutId);
  if (!layout) throw new ViewValidationError();
  applyViewConfig(ydoc, layout);
}

export function renameSavedViewLayout(ydoc: Y.Doc, layoutId: string, name: string): void {
  const map = getViewRoots(ydoc).savedLayouts.get(layoutId);
  const trimmed = name.trim().slice(0, 80);
  if (!map || !trimmed) throw new ViewValidationError();
  map.set("name", trimmed);
}

export function deleteSavedViewLayout(ydoc: Y.Doc, layoutId: string): void {
  const roots = getViewRoots(ydoc);
  ydoc.transact(() => {
    roots.savedLayouts.delete(layoutId);
    const position = roots.savedLayoutOrder.toArray().indexOf(layoutId);
    if (position >= 0) roots.savedLayoutOrder.delete(position, 1);
  }, "view-layout");
}

export function seedView(ydoc: Y.Doc): void {
  const roots = getViewRoots(ydoc);
  if (roots.config.has("layout")) return;
  ydoc.transact(() => {
    roots.config.set("layout", "table");
    roots.config.set("groupBy", null);
    roots.config.set("datePropertyId", "updatedAt");
    roots.config.set("coverPropertyId", null);
    roots.visibleColumns.insert(0, [...BUILTIN_VIEW_PROPERTIES]);
  }, "seed");
}

export function replaceViewState(current: Y.Doc, target: Y.Doc): void {
  const currentRoots = getViewRoots(current);
  const targetConfig = inspectView(target);
  const targetLayouts = inspectSavedLayouts(target);
  current.transact(() => {
    for (const key of [...currentRoots.config.keys()]) currentRoots.config.delete(key);
    currentRoots.config.set("layout", targetConfig.layout);
    currentRoots.config.set("groupBy", targetConfig.groupBy);
    currentRoots.config.set("datePropertyId", targetConfig.datePropertyId);
    currentRoots.config.set("coverPropertyId", targetConfig.coverPropertyId);
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
    for (const key of [...currentRoots.savedLayouts.keys()]) currentRoots.savedLayouts.delete(key);
    currentRoots.savedLayoutOrder.delete(0, currentRoots.savedLayoutOrder.length);
    for (const layout of targetLayouts) {
      const map = new Y.Map<unknown>();
      map.set("name", layout.name);
      map.set(
        "config",
        JSON.stringify({
          layout: layout.layout,
          visibleColumns: layout.visibleColumns,
          groupBy: layout.groupBy,
          datePropertyId: layout.datePropertyId,
          filters: layout.filters,
          sorts: layout.sorts,
          coverPropertyId: layout.coverPropertyId,
        }),
      );
      currentRoots.savedLayouts.set(layout.id, map);
    }
    currentRoots.savedLayoutOrder.insert(
      0,
      targetLayouts.map((layout) => layout.id),
    );
  }, "replace-view");
}
