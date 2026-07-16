"use client";

import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowRight, Check, ChevronDown, Link2, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MentionCandidate } from "@/app/dashboard/projects/[id]/editor/comments-rail";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { Button } from "@/components/ui/button";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { Dialog } from "@/components/ui/dialog";
import { useAnchoredPosition, useOutsideClose } from "@/components/ui/floating";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fieldClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

type Property = {
  id: string;
  name: string;
  type: "text" | "number" | "boolean" | "date" | "status" | "person";
  options: Array<{ id: string; name: string; color: string }>;
};

type Value = {
  propertyId: string;
  displayValue: string;
  textValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
  dateValue?: number;
  dateEndValue?: number;
  statusOptionId?: string;
  personUserId?: string;
};

function InlineSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const floatingRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(() => setOpen(false), floatingRef);
  const position = useAnchoredPosition({ open, anchorRef: ref, floatingRef, estimatedHeight: 208 });
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          fieldClass,
          "flex h-10 w-full cursor-pointer items-center justify-between gap-2 text-left disabled:cursor-not-allowed",
        )}
      >
        <span className="truncate">
          {options.find((option) => option.value === value)?.label ?? "None"}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={floatingRef}
              role="listbox"
              aria-label={label}
              className="fixed z-[180] max-h-52 space-y-1 overflow-auto rounded-md border border-hairline bg-surface p-1 shadow-xl"
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

export function RecordDetailsDialog({
  open,
  projectId,
  documentId,
  sourceCardId,
  nodes,
  members,
  canEdit,
  onClose,
  onOpenDocument,
}: {
  open: boolean;
  projectId: Id<"projects">;
  documentId: Id<"documents">;
  sourceCardId?: string;
  nodes: TreeNode[];
  members: MentionCandidate[];
  canEdit: boolean;
  onClose: () => void;
  onOpenDocument: (documentId: string) => void;
}) {
  const [targetSearch, setTargetSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const properties = useQuery(
    api.structuredSurfaces.listProperties,
    open ? { projectId } : "skip",
  ) as Property[] | undefined;
  const record = useQuery(api.structuredSurfaces.getRecord, open ? { documentId } : "skip") as
    | { properties: Value[] }
    | null
    | undefined;
  const outgoing = useQuery(
    api.structuredSurfaces.listOutgoingLinks,
    open ? { documentId } : "skip",
  );
  const backlinks = usePaginatedQuery(
    api.structuredSurfaces.listBacklinks,
    open ? { documentId } : "skip",
    { initialNumItems: 20 },
  );
  const addLink = useMutation(api.structuredSurfaces.addLink);
  const removeLink = useMutation(api.structuredSurfaces.removeLink);
  const setValue = useMutation(api.structuredSurfaces.setPropertyValue);
  const remoteTargets = useQuery(
    api.structuredSurfaces.searchLinkTargets,
    open && adding && targetSearch.trim().length >= 2
      ? { sourceDocumentId: documentId, term: targetSearch }
      : "skip",
  );
  const targets = useMemo(() => {
    const query = targetSearch.trim().toLowerCase();
    const local = nodes
      .filter(
        (node) =>
          node.kind === "file" &&
          node.id !== documentId &&
          (!query || node.name.toLowerCase().includes(query)),
      )
      .map((node) => ({ id: node.id, name: node.name, projectTitle: "This project" }));
    const seen = new Set(local.map((target) => target.id));
    return [...local, ...(remoteTargets ?? []).filter((target) => !seen.has(target.id))].slice(
      0,
      20,
    );
  }, [documentId, nodes, remoteTargets, targetSearch]);
  const visibleOutgoing = (outgoing ?? []).filter(
    (link) => (link.sourceCardId ?? undefined) === sourceCardId,
  );
  const update = async (
    property: Property,
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
        documentId,
        propertyId: property.id as Id<"documentProperties">,
        value,
      });
    } catch {
      notify.error("Couldn’t update property");
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={sourceCardId ? "Card relationships" : "Properties and backlinks"}
      icon={<Link2 className="size-4" />}
      description="Typed project data and access-safe document relationships."
      className="max-w-2xl"
      footer={
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      }
    >
      <div className="max-h-[70dvh] space-y-5 overflow-y-auto p-4">
        {!sourceCardId ? (
          <section>
            <h3 className="mb-2 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
              Properties
            </h3>
            {properties === undefined || record === undefined ? (
              <DataLoader label="Loading properties" compact />
            ) : properties.length === 0 ? (
              <DataState
                title="No project properties"
                description="Create properties from a Team view, then assign values here."
                compact
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {properties.map((property) => {
                  const current = record?.properties.find(
                    (value) => value.propertyId === property.id,
                  );
                  return (
                    <div key={property.id} className="block">
                      <span className="mb-1.5 block text-muted-foreground text-xs">
                        {property.name}
                      </span>
                      {property.type === "boolean" ? (
                        <button
                          type="button"
                          aria-label={property.name}
                          disabled={!canEdit}
                          onClick={() =>
                            void update(property, {
                              type: "boolean",
                              value: !current?.booleanValue,
                            })
                          }
                          className={cn(
                            fieldClass,
                            "flex h-10 w-full cursor-pointer items-center gap-2 text-left disabled:cursor-not-allowed",
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-4 items-center justify-center rounded-xs border border-hairline",
                              current?.booleanValue && "border-accent bg-accent",
                            )}
                          />
                          {current?.booleanValue ? "Yes" : "No"}
                        </button>
                      ) : property.type === "status" || property.type === "person" ? (
                        <InlineSelect
                          label={property.name}
                          disabled={!canEdit}
                          value={
                            property.type === "status"
                              ? (current?.statusOptionId ?? "")
                              : (current?.personUserId ?? "")
                          }
                          onChange={(value) => {
                            void update(
                              property,
                              value
                                ? property.type === "status"
                                  ? { type: "status", optionId: value }
                                  : { type: "person", userId: value }
                                : null,
                            );
                          }}
                          options={[
                            { value: "", label: "None" },
                            ...(property.type === "status"
                              ? property.options.map((option) => ({
                                  value: option.id,
                                  label: option.name,
                                }))
                              : members.map((member) => ({
                                  value: member.userId,
                                  label: `${member.name} · ${member.email}`,
                                }))),
                          ]}
                        />
                      ) : property.type === "date" ? (
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            disabled={!canEdit}
                            defaultValue={
                              current?.dateValue
                                ? new Date(current.dateValue).toISOString().slice(0, 10)
                                : ""
                            }
                            aria-label={`${property.name} start`}
                            placeholder="YYYY-MM-DD"
                            onBlur={(event) => {
                              const start = event.currentTarget.value.trim();
                              const end =
                                event.currentTarget.parentElement
                                  ?.querySelectorAll("input")[1]
                                  ?.value.trim() ?? "";
                              if (!start) void update(property, null);
                              else {
                                const value = Date.parse(`${start}T00:00:00.000Z`);
                                const endValue = end
                                  ? Date.parse(`${end}T00:00:00.000Z`)
                                  : undefined;
                                if (
                                  Number.isFinite(value) &&
                                  (endValue === undefined || endValue >= value)
                                )
                                  void update(property, { type: "date", value, endValue });
                              }
                            }}
                            className={cn(fieldClass, "h-10 min-w-0")}
                          />
                          <input
                            disabled={!canEdit}
                            defaultValue={
                              current?.dateEndValue
                                ? new Date(current.dateEndValue).toISOString().slice(0, 10)
                                : ""
                            }
                            aria-label={`${property.name} end`}
                            placeholder="End (optional)"
                            onBlur={(event) => {
                              const start =
                                event.currentTarget.parentElement
                                  ?.querySelector("input")
                                  ?.value.trim() ?? "";
                              const end = event.currentTarget.value.trim();
                              if (!start) return;
                              const value = Date.parse(`${start}T00:00:00.000Z`);
                              const endValue = end ? Date.parse(`${end}T00:00:00.000Z`) : undefined;
                              if (
                                Number.isFinite(value) &&
                                (endValue === undefined || endValue >= value)
                              )
                                void update(property, { type: "date", value, endValue });
                            }}
                            className={cn(fieldClass, "h-10 min-w-0")}
                          />
                        </div>
                      ) : (
                        <input
                          disabled={!canEdit}
                          aria-label={property.name}
                          defaultValue={current?.textValue ?? current?.numberValue ?? ""}
                          onBlur={(event) => {
                            const raw = event.currentTarget.value.trim();
                            if (!raw) void update(property, null);
                            else if (property.type === "number") {
                              const value = Number(raw);
                              if (Number.isFinite(value))
                                void update(property, { type: "number", value });
                            } else void update(property, { type: "text", value: raw });
                          }}
                          className={cn(fieldClass, "h-10 w-full")}
                          placeholder="Empty"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
              Links from here
            </h3>
            {canEdit ? (
              <Button size="sm" variant="secondary" onClick={() => setAdding((value) => !value)}>
                <Plus className="size-3.5" /> Link document
              </Button>
            ) : null}
          </div>
          {adding ? (
            <div className="mb-3 rounded-md border border-hairline bg-surface p-2">
              <input
                value={targetSearch}
                onChange={(event) => setTargetSearch(event.target.value)}
                className={cn(fieldClass, "h-9 w-full")}
                placeholder="Search accessible projects"
              />
              <div className="mt-2 max-h-44 overflow-y-auto">
                {targets.map((target) => (
                  <button
                    type="button"
                    key={target.id}
                    onClick={async () => {
                      try {
                        await addLink({
                          sourceDocumentId: documentId,
                          sourceCardId,
                          targetDocumentId: target.id as Id<"documents">,
                        });
                        setAdding(false);
                        setTargetSearch("");
                      } catch {
                        notify.error("Couldn’t add link");
                      }
                    }}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-xs hover:bg-foreground/[0.05]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{target.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {target.projectTitle}
                      </span>
                    </span>
                    <Plus className="size-3.5" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {outgoing === undefined ? (
            <DataLoader label="Loading links" compact />
          ) : visibleOutgoing.length === 0 ? (
            <p className="rounded-md border border-hairline border-dashed p-3 text-muted-foreground text-xs">
              No linked documents.
            </p>
          ) : (
            <div className="space-y-1">
              {visibleOutgoing.map((link) => (
                <div
                  key={link.id}
                  className="flex items-center gap-2 rounded-md border border-hairline px-3 py-2"
                >
                  <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
                  <button
                    type="button"
                    disabled={!link.targetDocumentId}
                    onClick={() => link.targetDocumentId && onOpenDocument(link.targetDocumentId)}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs disabled:cursor-default"
                  >
                    {link.title}
                  </button>
                  {canEdit && !link.managedByBoard ? (
                    <button
                      type="button"
                      onClick={() => void removeLink({ linkId: link.id })}
                      className="cursor-pointer p-1 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove link to ${link.title}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : link.managedByBoard ? (
                    <span className="text-[10px] text-muted-foreground">Board field</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
        {!sourceCardId ? (
          <section>
            <h3 className="mb-2 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
              Referenced by
            </h3>
            {backlinks.status === "LoadingFirstPage" ? (
              <DataLoader label="Loading backlinks" compact />
            ) : backlinks.results.length === 0 ? (
              <p className="rounded-md border border-hairline border-dashed p-3 text-muted-foreground text-xs">
                Nothing references this document yet.
              </p>
            ) : (
              <div className="space-y-1">
                {backlinks.results.map((link) => (
                  <button
                    type="button"
                    key={link.id}
                    disabled={!link.sourceDocumentId}
                    onClick={() => link.sourceDocumentId && onOpenDocument(link.sourceDocumentId)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-hairline px-3 py-2 text-left text-xs hover:bg-foreground/[0.04] disabled:cursor-default"
                  >
                    <span className="min-w-0 flex-1 truncate">{link.title}</span>
                    {link.sourceCardId ? <span className="text-muted-foreground">Card</span> : null}
                    <ArrowRight className="size-3.5" />
                  </button>
                ))}
                {backlinks.status === "CanLoadMore" ? (
                  <Button variant="secondary" size="sm" onClick={() => backlinks.loadMore(20)}>
                    Load more
                  </Button>
                ) : null}
              </div>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
