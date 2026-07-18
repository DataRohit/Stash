import * as Y from "yjs";

export const MAX_DASHBOARD_TILES = 24;
export const MAX_DASHBOARD_STATE_BYTES = 192 * 1024;
export const MAX_DASHBOARD_STORED_BYTES = 256 * 1024;

export type DashboardTile = {
  id: string;
  kind: "chart" | "stat";
  title: string;
  sourceDocId: string;
  aggregate: "count" | "sum";
  propertyId: string | null;
  x: number;
  y: number;
  width: 1 | 2;
  height: 1 | 2;
};

export type DashboardRoots = {
  tiles: Y.Map<Y.Map<unknown>>;
  order: Y.Array<string>;
};

export class DashboardValidationError extends Error {
  constructor() {
    super("invalid-update");
    this.name = "DashboardValidationError";
  }
}

export function dashboardId(): string {
  return crypto.randomUUID();
}

export function getDashboardRoots(ydoc: Y.Doc): DashboardRoots {
  return {
    tiles: ydoc.getMap<Y.Map<unknown>>("dashboardTiles"),
    order: ydoc.getArray<string>("dashboardTileOrder"),
  };
}

export function seedDashboard(ydoc: Y.Doc): void {
  getDashboardRoots(ydoc);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(value);
}

function coordinate(value: unknown, max: number): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new DashboardValidationError();
  }
  return Number(value);
}

export function inspectDashboard(ydoc: Y.Doc): DashboardTile[] {
  const roots = getDashboardRoots(ydoc);
  if (roots.tiles.size > MAX_DASHBOARD_TILES || roots.order.length > MAX_DASHBOARD_TILES * 4) {
    throw new DashboardValidationError();
  }
  const seen = new Set<string>();
  const order = roots.order.toArray().filter((id) => {
    if (!isId(id) || seen.has(id)) throw new DashboardValidationError();
    seen.add(id);
    return true;
  });
  if (order.length !== roots.tiles.size) throw new DashboardValidationError();
  return order.map((id) => {
    const map = roots.tiles.get(id);
    if (!map) throw new DashboardValidationError();
    const kind = map.get("kind");
    const title = map.get("title");
    const sourceDocId = map.get("sourceDocId");
    const aggregate = map.get("aggregate") ?? "count";
    const propertyId = map.get("propertyId") ?? null;
    const width = coordinate(map.get("width") ?? 1, 2);
    const height = coordinate(map.get("height") ?? 1, 2);
    if (
      (kind !== "chart" && kind !== "stat") ||
      typeof title !== "string" ||
      title.length > 120 ||
      !isId(sourceDocId) ||
      (aggregate !== "count" && aggregate !== "sum") ||
      !(propertyId === null || isId(propertyId)) ||
      (width !== 1 && width !== 2) ||
      (height !== 1 && height !== 2) ||
      [...map.keys()].some(
        (key) =>
          ![
            "kind",
            "title",
            "sourceDocId",
            "aggregate",
            "propertyId",
            "x",
            "y",
            "width",
            "height",
          ].includes(key),
      )
    ) {
      throw new DashboardValidationError();
    }
    return {
      id,
      kind,
      title,
      sourceDocId,
      aggregate,
      propertyId: propertyId as string | null,
      x: coordinate(map.get("x") ?? 0, 11),
      y: coordinate(map.get("y") ?? 0, MAX_DASHBOARD_TILES),
      width,
      height,
    };
  });
}

export function createDashboardTile(tile: Omit<DashboardTile, "id">): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("kind", tile.kind);
  map.set("title", tile.title.slice(0, 120));
  map.set("sourceDocId", tile.sourceDocId);
  map.set("aggregate", tile.aggregate);
  map.set("propertyId", tile.propertyId);
  map.set("x", tile.x);
  map.set("y", tile.y);
  map.set("width", tile.width);
  map.set("height", tile.height);
  return map;
}

export function replaceDashboardState(current: Y.Doc, target: Y.Doc): void {
  const currentRoots = getDashboardRoots(current);
  const tiles = inspectDashboard(target);
  current.transact(() => {
    for (const id of [...currentRoots.tiles.keys()]) currentRoots.tiles.delete(id);
    currentRoots.order.delete(0, currentRoots.order.length);
    for (const tile of tiles) {
      currentRoots.tiles.set(tile.id, createDashboardTile(tile));
    }
    currentRoots.order.insert(
      0,
      tiles.map((tile) => tile.id),
    );
  }, "replace-dashboard");
}
