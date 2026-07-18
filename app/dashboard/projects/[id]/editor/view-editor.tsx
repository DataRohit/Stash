"use client";

import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  ArrowUpDown,
  CalendarDays,
  Check,
  ChevronDown,
  Columns3,
  Filter,
  FunctionSquare,
  GalleryVerticalEnd,
  LayoutList,
  Plus,
  Rows3,
  Search,
  TableProperties,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { MentionCandidate } from "@/app/dashboard/projects/[id]/editor/comments-rail";
import { Button } from "@/components/ui/button";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { Dialog } from "@/components/ui/dialog";
import { useAnchoredPosition, useOutsideClose } from "@/components/ui/floating";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fieldClass } from "@/lib/ui";
import { cn } from "@/lib/utils";
import {
  applySavedViewLayout,
  applyViewConfig,
  BUILTIN_VIEW_PROPERTIES,
  deleteSavedViewLayout,
  getViewRoots,
  inspectSavedLayouts,
  inspectView,
  renameSavedViewLayout,
  saveCurrentViewLayout,
  type ViewFilterOperator,
  type ViewLayout,
  viewId,
} from "@/lib/view-model";

type PropertyType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "status"
  | "person"
  | "formula"
  | "rollup";

type PropertyDefinition = {
  id: string;
  name: string;
  type: PropertyType;
  options: Array<{ id: string; name: string; color: string }>;
  deleted: boolean;
  expression?: string;
  rollup?: { operation: "count" | "sum" | "latest"; propertyId?: string };
};

type PropertyValue = {
  propertyId: string;
  type: PropertyType;
  displayValue: string;
  textValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
  dateValue?: number;
  dateEndValue?: number;
  statusOptionId?: string;
  personUserId?: string;
};

type RecordRow = {
  id: string;
  sourceDocumentId?: string;
  name: string;
  fileType: string | null;
  updatedAt: number;
  boardColumn?: string;
  boardDue?: number;
  properties: PropertyValue[];
};

type SelectOption = { value: string; label: string };

const LAYOUTS: Array<{ id: ViewLayout; label: string; icon: typeof Rows3 }> = [
  { id: "table", label: "Table", icon: TableProperties },
  { id: "board", label: "Board", icon: Columns3 },
  { id: "timeline", label: "Timeline", icon: Rows3 },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "gallery", label: "Gallery", icon: GalleryVerticalEnd },
];

const PROPERTY_TYPE_OPTIONS: SelectOption[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Checkbox" },
  { value: "date", label: "Date" },
  { value: "status", label: "Status" },
  { value: "person", label: "Person" },
  { value: "formula", label: "Formula" },
  { value: "rollup", label: "Rollup" },
];

function MenuSelect({
  label,
  value,
  options,
  disabled = false,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const floatingRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(() => setOpen(false), floatingRef);
  const position = useAnchoredPosition({ open, anchorRef: ref, floatingRef, estimatedHeight: 224 });
  const selected = options.find((option) => option.value === value);
  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          fieldClass,
          "flex h-9 w-full cursor-pointer items-center justify-between gap-2 text-left text-xs disabled:cursor-not-allowed",
        )}
      >
        <span className="truncate">{selected?.label ?? "Select"}</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={floatingRef}
              data-view-menu-listbox="true"
              role="listbox"
              aria-label={label}
              className="fixed z-[180] max-h-56 space-y-1 overflow-auto rounded-md border border-hairline bg-surface p-1 shadow-xl"
              style={position}
            >
              {options.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  key={option.value}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left text-xs hover:bg-foreground/[0.06]",
                    option.value === value && "bg-foreground/[0.08]",
                  )}
                >
                  <Check className={cn("size-3.5", option.value !== value && "opacity-0")} />
                  <span className="truncate">{option.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function coverImageUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function builtinName(id: string): string | null {
  if (id === "title") return "Document";
  if (id === "fileType") return "Type";
  if (id === "updatedAt") return "Updated";
  if (id === "boardDue") return "Board due date";
  if (id === "boardColumn") return "Board column";
  return null;
}

function valueFor(record: RecordRow, propertyId: string): string {
  if (propertyId === "title") return record.name;
  if (propertyId === "fileType") return record.fileType ?? "Unknown";
  if (propertyId === "updatedAt") return String(record.updatedAt);
  if (propertyId === "boardDue")
    return record.boardDue ? new Date(record.boardDue).toISOString() : "";
  if (propertyId === "boardColumn") return record.boardColumn ?? "";
  return record.properties.find((value) => value.propertyId === propertyId)?.displayValue ?? "";
}

function dateFor(
  record: RecordRow,
  propertyId: string | null,
): { start: number; end: number } | null {
  if (!propertyId) return null;
  if (propertyId === "updatedAt") return { start: record.updatedAt, end: record.updatedAt };
  if (propertyId === "boardDue") {
    return record.boardDue === undefined ? null : { start: record.boardDue, end: record.boardDue };
  }
  const value = record.properties.find((row) => row.propertyId === propertyId);
  return value?.dateValue === undefined
    ? null
    : { start: value.dateValue, end: value.dateEndValue ?? value.dateValue };
}

function matches(record: RecordRow, propertyId: string, operator: ViewFilterOperator, raw: string) {
  const value = valueFor(record, propertyId);
  const left = value.toLocaleLowerCase();
  const right = raw.trim().toLocaleLowerCase();
  if (operator === "is-empty") return value.length === 0;
  if (operator === "is-not-empty") return value.length > 0;
  if (operator === "contains") return left.includes(right);
  if (operator === "equals") return left === right;
  if (operator === "not-equals") return left !== right;
  const propertyValue = record.properties.find((row) => row.propertyId === propertyId);
  const numeric =
    propertyId === "updatedAt"
      ? record.updatedAt
      : propertyId === "boardDue"
        ? (record.boardDue ?? Number.NaN)
        : operator === "before"
          ? (propertyValue?.dateEndValue ?? propertyValue?.dateValue ?? Date.parse(value))
          : (propertyValue?.dateValue ?? Date.parse(value));
  const target = Date.parse(raw);
  if (!Number.isFinite(numeric) || !Number.isFinite(target)) return false;
  return operator === "before" ? numeric < target : numeric > target;
}

function formatDate(value: number, dateOnly = false): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(dateOnly ? { timeZone: "UTC" } : {}),
  }).format(value);
}

function PropertyCell({
  record,
  property,
  members,
  canEdit,
}: {
  record: RecordRow;
  property: PropertyDefinition;
  members: MentionCandidate[];
  canEdit: boolean;
}) {
  const setValue = useMutation(api.structuredSurfaces.setPropertyValue);
  const current = record.properties.find((value) => value.propertyId === property.id);
  if (property.type === "formula" || property.type === "rollup") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs"
        title={
          property.type === "formula"
            ? property.expression
            : `${property.rollup?.operation ?? "count"} linked records`
        }
      >
        <FunctionSquare className="size-3.5 text-muted-foreground" />
        {current?.displayValue || "—"}
      </span>
    );
  }
  const save = async (
    value:
      | { type: "text"; value: string }
      | { type: "number"; value: number }
      | { type: "boolean"; value: boolean }
      | { type: "date"; value: number; endValue?: number }
      | { type: "status"; optionId: string }
      | { type: "person"; userId: string }
      | null,
  ) => {
    try {
      await setValue({
        documentId: record.id as Id<"documents">,
        propertyId: property.id as Id<"documentProperties">,
        value,
      });
    } catch {
      notify.error("Couldn’t update property");
    }
  };
  if (!canEdit) return <span className="text-xs">{current?.displayValue || "—"}</span>;
  if (property.type === "boolean") {
    return (
      <button
        type="button"
        onClick={() => void save({ type: "boolean", value: !current?.booleanValue })}
        className={cn(
          "flex size-5 cursor-pointer items-center justify-center rounded-xs border border-hairline",
          current?.booleanValue && "border-accent bg-accent text-accent-foreground",
        )}
        aria-label={`Toggle ${property.name}`}
      >
        {current?.booleanValue ? <Check className="size-3.5" /> : null}
      </button>
    );
  }
  if (property.type === "status") {
    return (
      <MenuSelect
        label={property.name}
        value={current?.statusOptionId ?? ""}
        options={[
          { value: "", label: "None" },
          ...property.options.map((row) => ({ value: row.id, label: row.name })),
        ]}
        onChange={(optionId) => void save(optionId ? { type: "status", optionId } : null)}
      />
    );
  }
  if (property.type === "person") {
    return (
      <MenuSelect
        label={property.name}
        value={current?.personUserId ?? ""}
        options={[
          { value: "", label: "Unassigned" },
          ...members.map((member) => ({
            value: member.userId,
            label: `${member.name}${member.role === "org:guest" ? " · Guest" : ""} · ${member.email}`,
          })),
        ]}
        onChange={(userId) => void save(userId ? { type: "person", userId } : null)}
      />
    );
  }
  if (property.type === "date") {
    const start = current?.dateValue ? new Date(current.dateValue).toISOString().slice(0, 10) : "";
    const end = current?.dateEndValue
      ? new Date(current.dateEndValue).toISOString().slice(0, 10)
      : "";
    const saveDates = (nextStart: string, nextEnd: string) => {
      if (!nextStart) return void save(null);
      const value = Date.parse(`${nextStart}T00:00:00.000Z`);
      const endValue = nextEnd ? Date.parse(`${nextEnd}T00:00:00.000Z`) : undefined;
      if (Number.isFinite(value) && (endValue === undefined || endValue >= value)) {
        void save({ type: "date", value, endValue });
      }
    };
    return (
      <div className="grid min-w-64 grid-cols-2 gap-1">
        <input
          defaultValue={start}
          aria-label={`${property.name} start`}
          placeholder="YYYY-MM-DD"
          onBlur={(event) =>
            saveDates(
              event.currentTarget.value.trim(),
              event.currentTarget.parentElement?.querySelectorAll("input")[1]?.value.trim() ?? "",
            )
          }
          className="h-8 min-w-0 rounded-sm border border-transparent bg-transparent px-2 text-xs outline-none hover:border-hairline focus:border-accent/60 focus:bg-background"
        />
        <input
          defaultValue={end}
          aria-label={`${property.name} end`}
          placeholder="End (optional)"
          onBlur={(event) =>
            saveDates(
              event.currentTarget.parentElement?.querySelector("input")?.value.trim() ?? "",
              event.currentTarget.value.trim(),
            )
          }
          className="h-8 min-w-0 rounded-sm border border-transparent bg-transparent px-2 text-xs outline-none hover:border-hairline focus:border-accent/60 focus:bg-background"
        />
      </div>
    );
  }
  const initial =
    property.type === "number" ? String(current?.numberValue ?? "") : (current?.textValue ?? "");
  return (
    <input
      key={`${record.id}:${property.id}:${initial}`}
      defaultValue={initial}
      inputMode={property.type === "number" ? "decimal" : undefined}
      placeholder="—"
      onBlur={(event) => {
        const raw = event.currentTarget.value.trim();
        if (!raw) void save(null);
        else if (property.type === "number") {
          const value = Number(raw);
          if (Number.isFinite(value)) void save({ type: "number", value });
        } else void save({ type: "text", value: raw });
      }}
      className="h-8 w-full min-w-28 rounded-sm border border-transparent bg-transparent px-2 text-xs outline-none hover:border-hairline focus:border-accent/60 focus:bg-background"
    />
  );
}

export function ViewEditor({
  projectId,
  ydoc,
  awareness,
  ready,
  canEdit,
  members,
  documentId,
  userId,
  onOpenDocument,
}: {
  projectId: Id<"projects">;
  ydoc: Y.Doc;
  awareness: Awareness;
  ready: boolean;
  canEdit: boolean;
  members: MentionCandidate[];
  documentId: string;
  userId: string;
  onOpenDocument: (documentId: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [propertyDialog, setPropertyDialog] = useState(false);
  const [deletePropertyId, setDeletePropertyId] = useState<string | null>(null);
  const [propertyName, setPropertyName] = useState("");
  const [propertyType, setPropertyType] = useState<PropertyType>("text");
  const [propertyExpression, setPropertyExpression] = useState("");
  const [rollupOperation, setRollupOperation] = useState<"count" | "sum" | "latest">("count");
  const [rollupPropertyId, setRollupPropertyId] = useState("");
  const [personalLayouts, setPersonalLayouts] = useState<
    Array<{ id: string; name: string; config: ReturnType<typeof inspectView> }>
  >([]);
  const [layoutDialog, setLayoutDialog] = useState(false);
  const [layoutName, setLayoutName] = useState("");
  const [layoutScope, setLayoutScope] = useState<"shared" | "personal">("personal");
  const [openMenu, setOpenMenu] = useState<"filter" | "sort" | "column" | null>(null);
  const toolbarMenuRef = useRef<HTMLDivElement>(null);
  const toolbarFloatingRef = useRef<HTMLDivElement>(null);
  const filterAnchorRef = useRef<HTMLDivElement>(null);
  const sortAnchorRef = useRef<HTMLDivElement>(null);
  const columnAnchorRef = useRef<HTMLDivElement>(null);
  const filterOpen = openMenu === "filter";
  const sortOpen = openMenu === "sort";
  const columnOpen = openMenu === "column";
  const filterPosition = useAnchoredPosition({
    open: filterOpen,
    anchorRef: filterAnchorRef,
    floatingRef: toolbarFloatingRef,
    estimatedHeight: 360,
    requestedWidth: 512,
    align: "end",
  });
  const sortPosition = useAnchoredPosition({
    open: sortOpen,
    anchorRef: sortAnchorRef,
    floatingRef: toolbarFloatingRef,
    estimatedHeight: 320,
    requestedWidth: 448,
    align: "end",
  });
  const columnPosition = useAnchoredPosition({
    open: columnOpen,
    anchorRef: columnAnchorRef,
    floatingRef: toolbarFloatingRef,
    estimatedHeight: 320,
    requestedWidth: 256,
    align: "end",
  });
  const toggleMenu = (menu: "filter" | "sort" | "column") =>
    setOpenMenu((current) => (current === menu ? null : menu));
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const createProperty = useMutation(api.structuredSurfaces.createProperty);
  const deleteProperty = useMutation(api.structuredSurfaces.deleteProperty);
  const propertyRows = useQuery(api.structuredSurfaces.listProperties, { projectId }) as
    | PropertyDefinition[]
    | undefined;
  const { results, status, loadMore } = usePaginatedQuery(
    api.structuredSurfaces.listRecords,
    { projectId },
    { initialNumItems: 40 },
  );
  const {
    results: cardResults,
    status: cardStatus,
    loadMore: loadMoreCards,
  } = usePaginatedQuery(
    api.structuredSurfaces.listBoardCardRecords,
    { projectId },
    { initialNumItems: 40 },
  );
  useEffect(() => {
    const update = () => setRevision((current) => current + 1);
    ydoc.on("update", update);
    awareness.on("change", update);
    return () => {
      ydoc.off("update", update);
      awareness.off("change", update);
    };
  }, [awareness, ydoc]);
  useEffect(() => {
    if (!openMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      const insideNestedListbox =
        target instanceof Element && target.closest('[data-view-menu-listbox="true"]');
      if (
        !toolbarMenuRef.current?.contains(target) &&
        !toolbarFloatingRef.current?.contains(target) &&
        !insideNestedListbox
      ) {
        setOpenMenu(null);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onEscape);
    };
  }, [openMenu]);
  const config = useMemo(() => {
    void revision;
    if (!ready) return null;
    try {
      return inspectView(ydoc);
    } catch {
      return null;
    }
  }, [ready, revision, ydoc]);
  const savedLayouts = useMemo(() => {
    void revision;
    if (!ready) return [];
    try {
      return inspectSavedLayouts(ydoc);
    } catch {
      return [];
    }
  }, [ready, revision, ydoc]);
  useEffect(() => {
    const key = `stash:view-layouts:${userId}:${documentId}`;
    const timer = window.setTimeout(() => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
        setPersonalLayouts(
          Array.isArray(parsed)
            ? parsed.slice(0, 24).map((layout) => ({ ...layout, id: layout.id || viewId() }))
            : [],
        );
      } catch {
        setPersonalLayouts([]);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [documentId, userId]);
  const properties = useMemo(() => propertyRows ?? [], [propertyRows]);
  const propertyById = useMemo(
    () => new Map(properties.map((property) => [property.id, property])),
    [properties],
  );
  const knownPropertyOptions: SelectOption[] = [
    ...BUILTIN_VIEW_PROPERTIES.map((id) => ({ value: id, label: builtinName(id) ?? id })),
    ...properties.map((property) => ({ value: property.id, label: property.name })),
  ];
  const referencedPropertyIds = config
    ? [
        ...config.visibleColumns,
        ...config.filters.map((filter) => filter.propertyId),
        ...config.sorts.map((sort) => sort.propertyId),
        ...(config.groupBy ? [config.groupBy] : []),
        ...(config.datePropertyId ? [config.datePropertyId] : []),
      ]
    : [];
  const knownIds = new Set(knownPropertyOptions.map((option) => option.value));
  const propertyOptions: SelectOption[] = [
    ...knownPropertyOptions,
    ...[...new Set(referencedPropertyIds)]
      .filter((id) => !knownIds.has(id) && id !== "boardDue" && id !== "boardColumn")
      .map((id) => ({ value: id, label: "Unknown property" })),
  ];
  const rows = useMemo(() => {
    if (!config) return [];
    const query = search.trim().toLocaleLowerCase();
    const filtered = (results as RecordRow[]).filter(
      (record) =>
        (!query || record.name.toLocaleLowerCase().includes(query)) &&
        config.filters.every((filter) => {
          const known =
            builtinName(filter.propertyId) !== null || propertyById.has(filter.propertyId);
          return !known || matches(record, filter.propertyId, filter.operator, filter.value);
        }),
    );
    return filtered.sort((left, right) => {
      for (const sort of config.sorts) {
        if (builtinName(sort.propertyId) === null && !propertyById.has(sort.propertyId)) continue;
        const result = valueFor(left, sort.propertyId).localeCompare(
          valueFor(right, sort.propertyId),
          undefined,
          { numeric: true, sensitivity: "base" },
        );
        if (result !== 0) return sort.direction === "asc" ? result : -result;
      }
      return left.name.localeCompare(right.name);
    });
  }, [config, propertyById, results, search]);
  if (!ready || !config || propertyRows === undefined || status === "LoadingFirstPage") {
    return <DataLoader label="Loading team view" className="h-full" />;
  }
  const roots = getViewRoots(ydoc);
  const setLayout = (layout: ViewLayout) => {
    if (!canEdit) return;
    ydoc.transact(() => roots.config.set("layout", layout), "view-edit");
  };
  const setVisible = (propertyId: string, visible: boolean) => {
    if (!canEdit) return;
    ydoc.transact(() => {
      const index = roots.visibleColumns.toArray().indexOf(propertyId);
      if (visible && index < 0) roots.visibleColumns.push([propertyId]);
      if (!visible && index >= 0) roots.visibleColumns.delete(index, 1);
    }, "view-edit");
  };
  const addFilter = () => {
    if (!canEdit || config.filters.length >= 16) return;
    const id = viewId();
    const filter = new Y.Map<unknown>();
    filter.set("propertyId", "title");
    filter.set("operator", "contains");
    filter.set("value", "");
    ydoc.transact(() => {
      roots.filters.set(id, filter);
      roots.filterOrder.push([id]);
    }, "view-edit");
  };
  const removeFilter = (id: string) => {
    if (!canEdit) return;
    ydoc.transact(() => {
      roots.filters.delete(id);
      const index = roots.filterOrder.toArray().indexOf(id);
      if (index >= 0) roots.filterOrder.delete(index, 1);
    }, "view-edit");
  };
  const addSort = () => {
    if (!canEdit || config.sorts.length >= 8) return;
    const id = viewId();
    const sort = new Y.Map<unknown>();
    sort.set("propertyId", "title");
    sort.set("direction", "asc");
    ydoc.transact(() => {
      roots.sorts.set(id, sort);
      roots.sortOrder.push([id]);
    }, "view-edit");
  };
  const removeSort = (id: string) => {
    if (!canEdit) return;
    ydoc.transact(() => {
      roots.sorts.delete(id);
      const index = roots.sortOrder.toArray().indexOf(id);
      if (index >= 0) roots.sortOrder.delete(index, 1);
    }, "view-edit");
  };
  const remoteRecords = new Map<string, Array<{ name: string; color: string }>>();
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;
    const documentId = (state.viewRecord as { documentId?: string } | undefined)?.documentId;
    const user = state.user as { name?: string; color?: string } | undefined;
    if (!documentId || !user) continue;
    remoteRecords.set(documentId, [
      ...(remoteRecords.get(documentId) ?? []),
      { name: user.name ?? "Collaborator", color: user.color ?? "#64748b" },
    ]);
  }
  const renderRecordCell = (record: RecordRow, propertyId: string) => {
    if (propertyId === "title") {
      const remote = remoteRecords.get(record.id) ?? [];
      return (
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenDocument(record.id)}
            className="max-w-72 cursor-pointer truncate font-medium text-sm hover:underline"
          >
            {record.name}
          </button>
          {remote.map((user) => (
            <span
              key={`${record.id}:${user.name}:${user.color}`}
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: user.color }}
              title={`${user.name} is viewing this record`}
            />
          ))}
        </span>
      );
    }
    if (propertyId === "fileType") {
      return <span className="text-muted-foreground text-xs uppercase">{record.fileType}</span>;
    }
    if (propertyId === "updatedAt") {
      return (
        <span className="whitespace-nowrap text-muted-foreground text-xs">
          {formatDate(record.updatedAt)}
        </span>
      );
    }
    const property = propertyById.get(propertyId);
    return property ? (
      <PropertyCell record={record} property={property} members={members} canEdit={canEdit} />
    ) : (
      <span className="text-muted-foreground text-xs">Unknown property</span>
    );
  };
  const groupProperty = config.groupBy ?? "fileType";
  const grouped = new Map<string, RecordRow[]>();
  for (const record of rows) {
    const group = valueFor(record, groupProperty) || "Unassigned";
    grouped.set(group, [...(grouped.get(group) ?? []), record]);
  }
  const temporalRows = (() => {
    if (config?.datePropertyId !== "boardDue") return rows;
    const query = search.trim().toLocaleLowerCase();
    const cards = (cardResults as RecordRow[]).filter(
      (record) =>
        (!query || record.name.toLocaleLowerCase().includes(query)) &&
        config.filters.every((filter) => {
          const known =
            builtinName(filter.propertyId) !== null || propertyById.has(filter.propertyId);
          return !known || matches(record, filter.propertyId, filter.operator, filter.value);
        }),
    );
    return [...rows, ...cards];
  })();
  const dated = temporalRows
    .map((record) => ({ record, date: dateFor(record, config.datePropertyId) }))
    .filter(
      (row): row is { record: RecordRow; date: { start: number; end: number } } =>
        row.date !== null,
    )
    .sort((left, right) => left.date.start - right.date.start);
  const unscheduled = temporalRows.filter(
    (record) => dateFor(record, config.datePropertyId) === null,
  );
  const calendarDays = Array.from(
    { length: 42 },
    (_, index) => new Date(month.getFullYear(), month.getMonth(), index - month.getDay() + 1),
  );
  const dateOnly = config.datePropertyId !== "updatedAt";
  const layoutIsEmpty =
    config.layout === "timeline" || config.layout === "calendar"
      ? temporalRows.length === 0
      : rows.length === 0;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-hairline border-b p-2">
        <div className="flex items-center gap-1 rounded-md border border-hairline p-1">
          {LAYOUTS.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              onClick={() => setLayout(id)}
              aria-pressed={config.layout === id}
              className={cn(
                "flex h-8 cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-xs transition-colors",
                config.layout === id
                  ? "bg-foreground/[0.09] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
        <select
          aria-label="Saved layouts"
          defaultValue=""
          onChange={(event) => {
            const value = event.target.value;
            event.currentTarget.value = "";
            try {
              if (value.startsWith("shared:")) {
                applySavedViewLayout(ydoc, value.slice(7));
              } else if (value.startsWith("personal:")) {
                const personal = personalLayouts[Number(value.slice(9))];
                if (personal) applyViewConfig(ydoc, personal.config);
              }
            } catch {
              notify.error("Couldn’t apply that layout", {
                description: "It refers to fields that no longer exist in this project.",
              });
            }
          }}
          className={cn(fieldClass, "h-9 max-w-48 text-xs")}
        >
          <option value="">Saved layouts</option>
          {savedLayouts.map((layout) => (
            <option key={layout.id} value={`shared:${layout.id}`}>
              {layout.name} · shared
            </option>
          ))}
          {personalLayouts.map((layout, index) => (
            <option key={layout.id} value={`personal:${index}`}>
              {layout.name} · personal
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setLayoutName("");
            setLayoutScope(canEdit ? "shared" : "personal");
            setLayoutDialog(true);
          }}
        >
          Save layout
        </Button>
        <label className="flex h-9 min-w-44 flex-1 items-center gap-2 rounded-md border border-hairline bg-surface px-3 sm:max-w-72">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search loaded records"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
        </label>
        <div ref={toolbarMenuRef} className="flex flex-wrap items-center gap-2">
          <div ref={filterAnchorRef} className="relative">
            <Button variant="secondary" size="sm" onClick={() => toggleMenu("filter")}>
              <Filter className="size-3.5" />
              Filters{config.filters.length ? ` (${config.filters.length})` : ""}
            </Button>
            {filterOpen && typeof document !== "undefined"
              ? createPortal(
                  <div
                    ref={toolbarFloatingRef}
                    className="fixed z-[170] rounded-lg border border-hairline bg-surface p-3 shadow-xl"
                    style={filterPosition}
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <span className="font-medium text-sm">Shared filters</span>
                      <Button size="sm" variant="secondary" disabled={!canEdit} onClick={addFilter}>
                        <Plus className="size-3.5" /> Add
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {config.filters.length === 0 ? (
                        <p className="py-3 text-center text-muted-foreground text-xs">No filters</p>
                      ) : null}
                      {config.filters.map((filter) => (
                        <div key={filter.id} className="grid grid-cols-[1fr_8rem_1fr_auto] gap-2">
                          <MenuSelect
                            label="Filter property"
                            value={filter.propertyId}
                            options={propertyOptions}
                            disabled={!canEdit}
                            onChange={(propertyId) =>
                              roots.filters.get(filter.id)?.set("propertyId", propertyId)
                            }
                          />
                          <MenuSelect
                            label="Filter operator"
                            value={filter.operator}
                            disabled={!canEdit}
                            options={[
                              { value: "contains", label: "Contains" },
                              { value: "equals", label: "Equals" },
                              { value: "not-equals", label: "Not equal" },
                              { value: "is-empty", label: "Is empty" },
                              { value: "is-not-empty", label: "Not empty" },
                              { value: "before", label: "Before" },
                              { value: "after", label: "After" },
                            ]}
                            onChange={(operator) =>
                              roots.filters.get(filter.id)?.set("operator", operator)
                            }
                          />
                          <input
                            defaultValue={filter.value}
                            disabled={
                              !canEdit ||
                              filter.operator === "is-empty" ||
                              filter.operator === "is-not-empty"
                            }
                            onBlur={(event) =>
                              roots.filters
                                .get(filter.id)
                                ?.set("value", event.currentTarget.value.slice(0, 500))
                            }
                            className={cn(fieldClass, "h-9 min-w-0 text-xs")}
                            placeholder="Value"
                          />
                          <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => removeFilter(filter.id)}
                            className="flex size-9 cursor-pointer items-center justify-center rounded-sm border border-hairline text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed"
                            aria-label="Remove filter"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>,
                  document.body,
                )
              : null}
          </div>
          <div ref={sortAnchorRef} className="relative">
            <Button variant="secondary" size="sm" onClick={() => toggleMenu("sort")}>
              <ArrowUpDown className="size-3.5" />
              Sort{config.sorts.length ? ` (${config.sorts.length})` : ""}
            </Button>
            {sortOpen && typeof document !== "undefined"
              ? createPortal(
                  <div
                    ref={toolbarFloatingRef}
                    className="fixed z-[170] rounded-lg border border-hairline bg-surface p-3 shadow-xl"
                    style={sortPosition}
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <span className="font-medium text-sm">Shared sort</span>
                      <Button size="sm" variant="secondary" disabled={!canEdit} onClick={addSort}>
                        <Plus className="size-3.5" /> Add
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {config.sorts.length === 0 ? (
                        <p className="py-3 text-center text-muted-foreground text-xs">
                          No sort rules
                        </p>
                      ) : null}
                      {config.sorts.map((sort) => (
                        <div key={sort.id} className="grid grid-cols-[1fr_8rem_auto] gap-2">
                          <MenuSelect
                            label="Sort property"
                            value={sort.propertyId}
                            options={propertyOptions}
                            disabled={!canEdit}
                            onChange={(propertyId) =>
                              roots.sorts.get(sort.id)?.set("propertyId", propertyId)
                            }
                          />
                          <MenuSelect
                            label="Sort direction"
                            value={sort.direction}
                            options={[
                              { value: "asc", label: "Ascending" },
                              { value: "desc", label: "Descending" },
                            ]}
                            disabled={!canEdit}
                            onChange={(direction) =>
                              roots.sorts.get(sort.id)?.set("direction", direction)
                            }
                          />
                          <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => removeSort(sort.id)}
                            className="flex size-9 cursor-pointer items-center justify-center rounded-sm border border-hairline text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed"
                            aria-label="Remove sort"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>,
                  document.body,
                )
              : null}
          </div>
          <div ref={columnAnchorRef} className="relative">
            <Button variant="secondary" size="sm" onClick={() => toggleMenu("column")}>
              <LayoutList className="size-3.5" /> Fields
            </Button>
            {columnOpen && typeof document !== "undefined"
              ? createPortal(
                  <div
                    ref={toolbarFloatingRef}
                    className="fixed z-[170] rounded-lg border border-hairline bg-surface p-2 shadow-xl"
                    style={columnPosition}
                  >
                    {propertyOptions.map((property) => {
                      const checked = config.visibleColumns.includes(property.value);
                      return (
                        <button
                          type="button"
                          key={property.value}
                          disabled={!canEdit || (property.value === "title" && checked)}
                          onClick={() => setVisible(property.value, !checked)}
                          className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left text-xs hover:bg-foreground/[0.05] disabled:cursor-not-allowed"
                        >
                          <span
                            className={cn(
                              "flex size-4 items-center justify-center rounded-xs border border-hairline",
                              checked && "border-accent bg-accent text-accent-foreground",
                            )}
                          >
                            {checked ? <Check className="size-3" /> : null}
                          </span>
                          <span className="truncate">{property.label}</span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => {
                        setOpenMenu(null);
                        setPropertyDialog(true);
                      }}
                      className="mt-1 flex w-full cursor-pointer items-center gap-2 border-hairline border-t px-2 pt-2 text-accent text-xs disabled:cursor-not-allowed"
                    >
                      <Plus className="size-3.5" /> New property
                    </button>
                  </div>,
                  document.body,
                )
              : null}
          </div>
        </div>
        <span className="rounded-full border border-info/30 bg-info/8 px-2 py-1 text-[10px] text-info">
          Shared view
        </span>
      </div>
      {config.layout === "board" ||
      config.layout === "timeline" ||
      config.layout === "calendar" ||
      config.layout === "gallery" ? (
        <div className="flex shrink-0 items-center gap-2 border-hairline border-b bg-surface/40 px-3 py-2">
          <span className="text-muted-foreground text-xs">
            {config.layout === "board"
              ? "Group by"
              : config.layout === "gallery"
                ? "Cover property"
                : "Date property"}
          </span>
          <MenuSelect
            label={
              config.layout === "board"
                ? "Group property"
                : config.layout === "gallery"
                  ? "Cover property"
                  : "Date property"
            }
            value={
              config.layout === "board"
                ? groupProperty
                : config.layout === "gallery"
                  ? (config.coverPropertyId ?? "title")
                  : (config.datePropertyId ?? "updatedAt")
            }
            options={
              config.layout === "board" || config.layout === "gallery"
                ? propertyOptions.filter((option) => option.value !== "updatedAt")
                : propertyOptions
                    .filter(
                      (option) =>
                        option.value === "updatedAt" ||
                        propertyById.get(option.value)?.type === "date",
                    )
                    .concat([{ value: "boardDue", label: "Board card due date" }])
            }
            disabled={!canEdit}
            className="w-56"
            onChange={(propertyId) =>
              roots.config.set(
                config.layout === "board"
                  ? "groupBy"
                  : config.layout === "gallery"
                    ? "coverPropertyId"
                    : "datePropertyId",
                propertyId,
              )
            }
          />
        </div>
      ) : null}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
        {layoutIsEmpty ? (
          <DataState
            title="No matching records"
            description={
              status === "CanLoadMore"
                ? "Load more records or adjust the shared filters."
                : "Adjust the shared filters or add documents to this project."
            }
            className="h-full"
          />
        ) : config.layout === "table" ? (
          <table className="min-w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr>
                {config.visibleColumns.map((propertyId) => (
                  <th
                    key={propertyId}
                    className="min-w-40 border-hairline border-b px-3 py-2 text-left font-medium text-muted-foreground text-xs"
                  >
                    {builtinName(propertyId) ??
                      propertyById.get(propertyId)?.name ??
                      "Unknown property"}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => (
                <tr
                  key={record.id}
                  onPointerEnter={() =>
                    awareness.setLocalStateField("viewRecord", { documentId: record.id })
                  }
                  onPointerLeave={() => awareness.setLocalStateField("viewRecord", null)}
                  className="group hover:bg-foreground/[0.025]"
                >
                  {config.visibleColumns.map((propertyId) => (
                    <td
                      key={propertyId}
                      className="h-12 border-hairline border-b px-3 py-1.5 align-middle"
                    >
                      {renderRecordCell(record, propertyId)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : config.layout === "gallery" ? (
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((record) => {
              const cover = config.coverPropertyId
                ? record.properties.find((value) => value.propertyId === config.coverPropertyId)
                    ?.displayValue
                : "";
              return (
                <button
                  type="button"
                  key={record.id}
                  onClick={() => onOpenDocument(record.sourceDocumentId ?? record.id)}
                  className="overflow-hidden rounded-lg border border-hairline bg-surface text-left shadow-sm hover:border-foreground/25"
                >
                  <div className="relative h-36 bg-gradient-to-br from-accent/20 via-info/10 to-warning/15">
                    {coverImageUrl(cover) ? (
                      // biome-ignore lint/performance/noImgElement: covers are arbitrary remote URLs, not optimizable assets
                      <img
                        src={coverImageUrl(cover) as string}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="absolute inset-0 size-full object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="p-3">
                    <h3 className="truncate font-medium text-sm">{record.name}</h3>
                    <p className="mt-1 text-muted-foreground text-xs">
                      {record.fileType ?? "Document"} · {formatDate(record.updatedAt)}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        ) : config.layout === "board" ? (
          <div className="flex min-h-full min-w-max gap-3 p-3">
            {[...grouped.entries()].map(([group, records]) => (
              <section
                key={group}
                className="flex w-72 flex-col rounded-lg border border-hairline bg-surface/50"
              >
                <header className="flex h-11 items-center gap-2 border-hairline border-b px-3">
                  <span className="size-2 rounded-sm bg-accent" />
                  <h2 className="truncate font-medium text-sm">{group}</h2>
                  <span className="ml-auto rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px]">
                    {records.length}
                  </span>
                </header>
                <div className="space-y-2 p-2">
                  {records.map((record) => (
                    <button
                      type="button"
                      key={record.id}
                      onClick={() => onOpenDocument(record.sourceDocumentId ?? record.id)}
                      className="w-full cursor-pointer rounded-md border border-hairline bg-background p-3 text-left hover:border-foreground/25"
                    >
                      <span className="block truncate font-medium text-sm">{record.name}</span>
                      <span className="mt-2 flex items-center justify-between gap-2 text-muted-foreground text-xs">
                        <span className="uppercase">{record.fileType}</span>
                        <span>{formatDate(record.updatedAt)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : config.layout === "timeline" ? (
          <div className="min-w-[48rem] p-4">
            <div className="grid grid-cols-[11rem_1fr] border-hairline border-b pb-2 text-muted-foreground text-xs">
              <span>Record</span>
              <span>Date</span>
            </div>
            {dated.map(({ record, date }) => (
              <button
                type="button"
                key={record.id}
                onClick={() => onOpenDocument(record.sourceDocumentId ?? record.id)}
                className="grid w-full cursor-pointer grid-cols-[11rem_1fr] items-center border-hairline border-b py-3 text-left hover:bg-foreground/[0.025]"
              >
                <span className="truncate pr-3 font-medium text-sm">{record.name}</span>
                <span className="relative h-8 rounded-sm bg-foreground/[0.035]">
                  <span className="absolute inset-y-1 left-2 flex items-center rounded-sm border border-accent/35 bg-accent/10 px-3 text-xs">
                    {formatDate(date.start, dateOnly)}
                    {date.end !== date.start ? ` – ${formatDate(date.end, dateOnly)}` : ""}
                  </span>
                </span>
              </button>
            ))}
            {unscheduled.length > 0 ? (
              <section className="mt-5 rounded-md border border-hairline border-dashed p-3">
                <h3 className="mb-2 font-medium text-sm">Unscheduled · {unscheduled.length}</h3>
                <div className="flex flex-wrap gap-2">
                  {unscheduled.map((record) => (
                    <button
                      type="button"
                      key={record.id}
                      onClick={() => onOpenDocument(record.sourceDocumentId ?? record.id)}
                      className="cursor-pointer rounded-sm bg-foreground/[0.05] px-2 py-1 text-xs"
                    >
                      {record.name}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full min-w-[44rem] flex-col p-4">
            <div className="mb-3 flex shrink-0 items-center justify-between">
              <button
                type="button"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                className="cursor-pointer rounded-sm border border-hairline px-3 py-1.5 text-xs"
              >
                Previous
              </button>
              <h2 className="font-medium text-sm">
                {new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
                  month,
                )}
              </h2>
              <button
                type="button"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                className="cursor-pointer rounded-sm border border-hairline px-3 py-1.5 text-xs"
              >
                Next
              </button>
            </div>
            <div className="grid shrink-0 grid-cols-7 border-hairline border-t border-l">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => (
                <div
                  key={day}
                  className={cn(
                    "border-hairline border-r border-b bg-surface px-2 py-2 text-xs",
                    index === 0
                      ? "text-destructive"
                      : index === 6
                        ? "text-warning"
                        : "text-muted-foreground",
                  )}
                >
                  {day}
                </div>
              ))}
            </div>
            <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7 border-hairline border-l">
              {calendarDays.map((day) => {
                const dayStart = new Date(
                  day.getFullYear(),
                  day.getMonth(),
                  day.getDate(),
                ).valueOf();
                const utcDayStart = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
                const compareDay = dateOnly ? utcDayStart : dayStart;
                const weekday = day.getDay();
                const dayRecords = dated.filter(
                  ({ date }) => date.start <= compareDay && date.end >= compareDay,
                );
                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      "flex min-h-0 flex-col border-hairline border-r border-b p-1.5",
                      day.getMonth() !== month.getMonth() &&
                        "bg-foreground/[0.015] text-muted-foreground/50",
                    )}
                  >
                    <span
                      className={cn(
                        "block shrink-0 px-1 text-xs",
                        weekday === 0 && "text-destructive",
                        weekday === 6 && "text-warning",
                      )}
                    >
                      {day.getDate()}
                    </span>
                    <div className="thin-scrollbar mt-1 min-h-0 flex-1 space-y-1 overflow-y-auto">
                      {dayRecords.map(({ record }) => (
                        <button
                          type="button"
                          key={record.id}
                          onClick={() => onOpenDocument(record.sourceDocumentId ?? record.id)}
                          className="block w-full cursor-pointer truncate rounded-sm border border-accent/25 bg-accent/8 px-1.5 py-1 text-left text-[10px]"
                        >
                          {record.name}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {unscheduled.length > 0 ? (
              <p className="mt-3 shrink-0 text-muted-foreground text-xs">
                {unscheduled.length} unscheduled record{unscheduled.length === 1 ? "" : "s"}
              </p>
            ) : null}
          </div>
        )}
        {status === "CanLoadMore" ? (
          <div className="flex justify-center p-4">
            <Button variant="secondary" onClick={() => loadMore(40)}>
              Load 40 more records
            </Button>
          </div>
        ) : null}
        {(config.layout === "timeline" || config.layout === "calendar") &&
        config.datePropertyId === "boardDue" &&
        cardStatus === "CanLoadMore" ? (
          <div className="flex justify-center p-4">
            <Button variant="secondary" onClick={() => loadMoreCards(40)}>
              Load 40 more board cards
            </Button>
          </div>
        ) : null}
      </div>
      <Dialog
        open={layoutDialog}
        onClose={() => setLayoutDialog(false)}
        title="Save layout"
        icon={<LayoutList className="size-4" />}
        description="Stores the current layout, filters, sorts, grouping, and visible fields."
        className="max-w-md"
        mobileSheet
      >
        <form
          className="space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const name = layoutName.trim().slice(0, 80);
            if (!name || !config) return;
            try {
              if (layoutScope === "shared" && canEdit) {
                saveCurrentViewLayout(ydoc, name);
              } else {
                const next = [...personalLayouts, { id: viewId(), name, config }].slice(-24);
                setPersonalLayouts(next);
                window.localStorage.setItem(
                  `stash:view-layouts:${userId}:${documentId}`,
                  JSON.stringify(next),
                );
              }
              setLayoutDialog(false);
            } catch {
              notify.error("Couldn’t save that layout", {
                description: "This view already has the maximum number of saved layouts.",
              });
            }
          }}
        >
          <label className="block text-xs">
            Layout name
            <input
              value={layoutName}
              onChange={(event) => setLayoutName(event.target.value.slice(0, 80))}
              className={cn(fieldClass, "mt-1 h-9 w-full px-2")}
              placeholder="Overdue by owner"
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-muted-foreground text-xs">Who can use it</legend>
            {(
              [
                ["personal", "Only me", "Stored in this browser."],
                ["shared", "The whole team", "Stored in the shared view."],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={cn(
                  "flex items-start gap-2 rounded-md border border-hairline p-2 text-xs",
                  value === "shared" && !canEdit && "opacity-50",
                )}
              >
                <input
                  type="radio"
                  name="layout-scope"
                  value={value}
                  checked={layoutScope === value}
                  disabled={value === "shared" && !canEdit}
                  onChange={() => setLayoutScope(value)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium">{label}</span>
                  <span className="block text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setLayoutDialog(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!layoutName.trim()}>
              Save
            </Button>
          </div>
          {savedLayouts.length > 0 || personalLayouts.length > 0 ? (
            <div className="border-hairline border-t pt-3">
              <p className="mb-2 text-muted-foreground text-xs">Saved layouts</p>
              <ul className="max-h-52 space-y-1 overflow-auto">
                {savedLayouts.map((layout) => (
                  <li key={layout.id} className="flex items-center gap-2">
                    <input
                      aria-label={`Rename ${layout.name}`}
                      defaultValue={layout.name}
                      disabled={!canEdit}
                      onBlur={(event) => {
                        const next = event.target.value.trim();
                        if (!next || next === layout.name) {
                          event.target.value = layout.name;
                          return;
                        }
                        try {
                          renameSavedViewLayout(ydoc, layout.id, next);
                        } catch {
                          event.target.value = layout.name;
                        }
                      }}
                      className={cn(fieldClass, "h-8 min-w-0 flex-1 px-2 text-xs")}
                    />
                    <span className="shrink-0 text-[10px] text-muted-foreground">shared</span>
                    <button
                      type="button"
                      disabled={!canEdit}
                      aria-label={`Delete ${layout.name}`}
                      onClick={() => deleteSavedViewLayout(ydoc, layout.id)}
                      className="shrink-0 rounded-sm p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-40"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
                {personalLayouts.map((layout, index) => (
                  <li key={layout.id} className="flex items-center gap-2">
                    <input
                      aria-label={`Rename ${layout.name}`}
                      defaultValue={layout.name}
                      onBlur={(event) => {
                        const next = event.target.value.trim().slice(0, 80);
                        if (!next) {
                          event.target.value = layout.name;
                          return;
                        }
                        const updated = personalLayouts.map((item, position) =>
                          position === index ? { ...item, name: next } : item,
                        );
                        setPersonalLayouts(updated);
                        window.localStorage.setItem(
                          `stash:view-layouts:${userId}:${documentId}`,
                          JSON.stringify(updated),
                        );
                      }}
                      className={cn(fieldClass, "h-8 min-w-0 flex-1 px-2 text-xs")}
                    />
                    <span className="shrink-0 text-[10px] text-muted-foreground">personal</span>
                    <button
                      type="button"
                      aria-label={`Delete ${layout.name}`}
                      onClick={() => {
                        const updated = personalLayouts.filter((_, position) => position !== index);
                        setPersonalLayouts(updated);
                        window.localStorage.setItem(
                          `stash:view-layouts:${userId}:${documentId}`,
                          JSON.stringify(updated),
                        );
                      }}
                      className="shrink-0 rounded-sm p-1.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </form>
      </Dialog>
      <Dialog
        open={propertyDialog}
        onClose={() => setPropertyDialog(false)}
        title="New property"
        icon={<Plus className="size-4" />}
        description="Typed properties are shared by every team view in this project."
        className="max-w-md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPropertyDialog(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !propertyName.trim() ||
                (propertyType === "formula" && !propertyExpression.trim()) ||
                (propertyType === "rollup" && rollupOperation !== "count" && !rollupPropertyId)
              }
              onClick={async () => {
                const options =
                  propertyType === "status"
                    ? [
                        { id: viewId(), name: "To do", color: "#3b82f6" },
                        { id: viewId(), name: "In progress", color: "#8b5cf6" },
                        { id: viewId(), name: "Done", color: "#22c55e" },
                      ]
                    : undefined;
                try {
                  const propertyId = await createProperty({
                    projectId,
                    name: propertyName,
                    type: propertyType,
                    options,
                    expression: propertyType === "formula" ? propertyExpression : undefined,
                    rollup:
                      propertyType === "rollup"
                        ? {
                            operation: rollupOperation,
                            propertyId:
                              rollupOperation === "count"
                                ? undefined
                                : (rollupPropertyId as Id<"documentProperties">),
                          }
                        : undefined,
                  });
                  setVisible(propertyId, true);
                  setPropertyName("");
                  setPropertyExpression("");
                  setPropertyDialog(false);
                } catch {
                  notify.error("Couldn’t create property");
                }
              }}
            >
              <Plus className="size-4" />
              Create
            </Button>
          </div>
        }
      >
        <div className="space-y-4 p-4">
          <label className="block">
            <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
              Name
            </span>
            <input
              value={propertyName}
              onChange={(event) => setPropertyName(event.target.value.slice(0, 60))}
              className={cn(fieldClass, "h-10 w-full")}
              placeholder="Priority"
            />
          </label>
          <div>
            <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
              Type
            </span>
            <MenuSelect
              label="Property type"
              value={propertyType}
              options={PROPERTY_TYPE_OPTIONS}
              onChange={(value) => setPropertyType(value as PropertyType)}
            />
          </div>
          {propertyType === "formula" ? (
            <label className="block">
              <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                Expression
              </span>
              <textarea
                value={propertyExpression}
                onChange={(event) => setPropertyExpression(event.target.value.slice(0, 1000))}
                className={cn(fieldClass, "min-h-24 w-full p-2 text-xs")}
                placeholder={`{property-id} * 2 or JOIN(" · ",{property-id})`}
              />
              <span className="mt-1 block text-[10px] text-muted-foreground">
                Reference fields with their stable id shown below.
              </span>
            </label>
          ) : null}
          {propertyType === "rollup" ? (
            <div className="grid grid-cols-2 gap-2">
              <MenuSelect
                label="Rollup operation"
                value={rollupOperation}
                options={[
                  { value: "count", label: "Count links" },
                  { value: "sum", label: "Sum" },
                  { value: "latest", label: "Latest date" },
                ]}
                onChange={(value) => setRollupOperation(value as typeof rollupOperation)}
              />
              {rollupOperation !== "count" ? (
                <MenuSelect
                  label="Rollup property"
                  value={rollupPropertyId}
                  options={properties
                    .filter((property) =>
                      rollupOperation === "sum"
                        ? property.type === "number"
                        : property.type === "date",
                    )
                    .map((property) => ({ value: property.id, label: property.name }))}
                  onChange={setRollupPropertyId}
                />
              ) : (
                <div />
              )}
            </div>
          ) : null}
          {properties.length > 0 ? (
            <div className="border-hairline border-t pt-3">
              <p className="mb-2 text-muted-foreground text-xs">Existing properties</p>
              <div className="space-y-1">
                {properties.map((property) => (
                  <div
                    key={property.id}
                    className="flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 hover:bg-foreground/[0.04]"
                  >
                    <span className="truncate text-xs">
                      {property.name} · {property.type} · {property.id}
                    </span>
                    {deletePropertyId === property.id ? (
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setDeletePropertyId(null)}
                          className="cursor-pointer rounded-xs px-2 py-1 text-[10px] text-muted-foreground hover:bg-foreground/[0.05]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await deleteProperty({
                                propertyId: property.id as Id<"documentProperties">,
                              });
                              setDeletePropertyId(null);
                            } catch {
                              notify.error("Couldn’t delete property");
                            }
                          }}
                          className="cursor-pointer rounded-xs bg-destructive/10 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/15"
                        >
                          Delete
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDeletePropertyId(property.id)}
                        className="cursor-pointer p-1 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete ${property.name}`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
