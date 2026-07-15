"use client";

import {
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Link2,
  MessageSquare,
  Plus,
  Search,
  Tag,
  Trash2,
  UserRound,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { MentionCandidate } from "@/app/dashboard/projects/[id]/editor/comments-rail";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { notify } from "@/components/ui/toast";
import {
  type BoardPriority,
  boardColor,
  boardColorForId,
  boardId,
  createBoardCard,
  getBoardRoots,
  inspectBoard,
  MAX_BOARD_CARDS,
  MAX_BOARD_COLUMNS,
  MAX_BOARD_LABELS,
  orderedCards,
  UNFILED_COLUMN_ID,
} from "@/lib/board-model";
import { fieldClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

export type BoardCardSelection = { cardId: string; quote: string };

type DragState =
  | { kind: "card"; id: string; fromColumnId: string }
  | { kind: "column"; id: string }
  | null;

type NewCardDraft = {
  title: string;
  description: string;
  assignees: string[];
  labels: string[];
  due: number | null;
  linkedDocId: string | null;
  columnId: string;
  color: string;
  priority: BoardPriority | null;
};

const LABEL_COLORS = ["#2563eb", "#16a34a", "#ca8a04", "#dc2626", "#9333ea", "#0891b2"];
const COLOR_CHOICES = [
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#ec4899",
  "#f43f5e",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#64748b",
] as const;
const PRIORITIES: Array<{ value: BoardPriority; label: string; className: string }> = [
  { value: "low", label: "Low", className: "border-info/35 bg-info/10 text-info" },
  { value: "medium", label: "Medium", className: "border-warning/35 bg-warning/10 text-warning" },
  {
    value: "high",
    label: "High",
    className: "border-orange-500/35 bg-orange-500/10 text-orange-400",
  },
  {
    value: "critical",
    label: "Critical",
    className: "border-destructive/35 bg-destructive/10 text-destructive",
  },
];

function cardDueDetails(due: number): { label: string; className: string } {
  const target = new Date(due);
  const now = new Date();
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).valueOf();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(
    target,
  );
  if (targetDay < today) {
    return {
      label: `Overdue · ${date}`,
      className: "border-destructive/45 bg-destructive/10 text-destructive",
    };
  }
  if (targetDay === today) {
    return {
      label: "Due today",
      className: "border-warning/45 bg-warning/10 text-warning",
    };
  }
  return {
    label: `Due ${date}`,
    className: "border-hairline bg-foreground/[0.04] text-muted-foreground",
  };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  const last = parts[parts.length - 1];
  if (!last || last === first) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

function Avatar({
  member,
  px,
  className,
}: {
  member: MentionCandidate | undefined;
  px: number;
  className: string;
}) {
  if (member?.imageUrl) {
    return (
      <Image
        src={member.imageUrl}
        alt=""
        width={px}
        height={px}
        unoptimized
        className={cn("shrink-0 rounded-full border border-hairline object-cover", className)}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-hairline bg-foreground/[0.09] font-medium text-[10px] text-muted-foreground",
        className,
      )}
    >
      {member ? initials(member.name) : <UserRound className="size-3.5" />}
    </span>
  );
}

type SelectOption = { value: string; label: string; detail?: string };

function useOutsideClose(
  onClose: () => void,
  floatingRef?: { readonly current: HTMLElement | null },
) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !floatingRef?.current?.contains(target)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [floatingRef, onClose]);
  return ref;
}

function anchoredPosition(
  rect: DOMRect,
  height = 320,
  requestedWidth = rect.width,
  align: "start" | "end" = "start",
) {
  const gap = 6;
  const margin = 8;
  const width = Math.min(requestedWidth, window.innerWidth - margin * 2);
  const desiredLeft = align === "end" ? rect.right - width : rect.left;
  const left = Math.min(Math.max(margin, desiredLeft), window.innerWidth - width - margin);
  const below = rect.bottom + gap;
  const top =
    below + height <= window.innerHeight - margin
      ? below
      : Math.max(margin, rect.top - height - gap);
  return { left, top, width };
}

function ColorPicker({
  label,
  value,
  disabled,
  compact = false,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  compact?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const floatingRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(() => {
    setOpen(false);
    setDraft(value);
  }, floatingRef);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 256 });
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = ref.current?.getBoundingClientRect();
      if (trigger)
        setPosition(
          anchoredPosition(trigger, floatingRef.current?.offsetHeight ?? 280, 256, "start"),
        );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, ref]);
  const commit = () => {
    const normalized = draft.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(normalized)) onChange(normalized);
    else setDraft(value);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={(event) => {
          if (!open)
            setPosition(anchoredPosition(event.currentTarget.getBoundingClientRect(), 280, 256));
          setOpen((current) => !current);
        }}
        className={
          compact
            ? "block size-4 cursor-pointer overflow-hidden rounded-sm border border-white/20 p-0 outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed"
            : cn(
                fieldClass,
                "flex h-11 w-full cursor-pointer items-center gap-3 text-left disabled:cursor-not-allowed",
              )
        }
      >
        <span
          className={cn(
            "shrink-0 border border-white/20",
            compact ? "block size-full rounded-[2px]" : "size-5 rounded-full",
          )}
          style={{ backgroundColor: value }}
        />
        {!compact ? <span className="font-mono text-xs uppercase">{value}</span> : null}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={floatingRef}
              role="dialog"
              aria-label={label}
              className="fixed z-[180] rounded-lg border border-hairline bg-surface p-3 shadow-xl"
              style={position}
            >
              <p className="mb-2 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                Choose color
              </p>
              <div className="grid grid-cols-8 gap-2">
                {COLOR_CHOICES.map((color) => (
                  <button
                    type="button"
                    key={color}
                    aria-label={`Use ${color}`}
                    aria-pressed={value.toLowerCase() === color}
                    onClick={() => {
                      onChange(color);
                      setDraft(color);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex aspect-square cursor-pointer items-center justify-center rounded-full border border-white/15 transition-transform hover:scale-110",
                      value.toLowerCase() === color &&
                        "ring-2 ring-foreground ring-offset-2 ring-offset-surface",
                    )}
                    style={{ backgroundColor: color }}
                  >
                    {value.toLowerCase() === color ? <Check className="size-3 text-white" /> : null}
                  </button>
                ))}
              </div>
              <label className="mt-3 block">
                <span className="mb-1.5 block text-[10px] text-muted-foreground">Custom hex</span>
                <div className="flex gap-2">
                  <input
                    value={draft}
                    maxLength={7}
                    spellCheck={false}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commit();
                        setOpen(false);
                      }
                    }}
                    aria-label="Custom hex color"
                    className={cn(fieldClass, "h-9 min-w-0 flex-1 font-mono uppercase")}
                  />
                  <button
                    type="button"
                    disabled={!/^#[0-9a-f]{6}$/i.test(draft.trim())}
                    onClick={() => {
                      commit();
                      setOpen(false);
                    }}
                    className="cursor-pointer rounded-sm border border-hairline px-3 text-xs hover:bg-foreground/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Apply
                  </button>
                </div>
              </label>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function SelectMenu({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const floatingRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(() => setOpen(false), floatingRef);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 240 });
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = ref.current?.getBoundingClientRect();
      if (trigger)
        setPosition(
          anchoredPosition(trigger, floatingRef.current?.offsetHeight ?? 240, trigger.width),
        );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, ref]);
  const selected = options.find((option) => option.value === value);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(event) => {
          if (!open) {
            const rect = event.currentTarget.getBoundingClientRect();
            setPosition(anchoredPosition(rect, 240, rect.width));
          }
          setOpen((current) => !current);
        }}
        className={cn(
          fieldClass,
          "flex h-11 w-full cursor-pointer items-center justify-between gap-3 text-left disabled:cursor-not-allowed",
        )}
      >
        <span className="min-w-0 truncate">{selected?.label ?? "None"}</span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={floatingRef}
              role="listbox"
              aria-label={label}
              className="fixed z-[180] max-h-56 overflow-auto rounded-md border border-hairline bg-surface p-1 shadow-xl"
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
                    "flex w-full cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-foreground/[0.06]",
                    option.value === value && "bg-foreground/[0.08]",
                  )}
                >
                  <Check
                    className={cn("size-3.5 shrink-0", option.value !== value && "opacity-0")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.detail ? (
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {option.detail}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function DatePicker({
  value,
  disabled,
  onChange,
}: {
  value: number | null;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  const selected = value ? new Date(value) : null;
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const date = selected ?? new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });
  const calendarRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(() => setOpen(false), calendarRef);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 288 });
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = ref.current?.getBoundingClientRect();
      if (trigger)
        setPosition(
          anchoredPosition(trigger, calendarRef.current?.offsetHeight ?? 400, 288, "end"),
        );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, ref]);
  const firstWeekday = month.getDay();
  const days = Array.from(
    { length: 42 },
    (_, index) => new Date(month.getFullYear(), month.getMonth(), index - firstWeekday + 1),
  );
  const sameDay = (left: Date | null, right: Date) =>
    Boolean(
      left &&
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate(),
    );
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          if (!open)
            setPosition(
              anchoredPosition(event.currentTarget.getBoundingClientRect(), 400, 288, "end"),
            );
          setOpen((current) => !current);
        }}
        className={cn(
          fieldClass,
          "flex h-11 w-full cursor-pointer items-center justify-between gap-2 text-left disabled:cursor-not-allowed",
        )}
      >
        <span className={selected ? "text-foreground" : "text-muted-foreground"}>
          {selected
            ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(selected)
            : "Select a date"}
        </span>
        <CalendarDays className="size-4" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={calendarRef}
              role="dialog"
              aria-label="Choose due date"
              className="fixed z-[180] rounded-md border border-hairline bg-surface p-3 shadow-xl"
              style={position}
            >
              <div className="mb-3 flex items-center justify-between">
                <strong className="text-sm">
                  {new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
                    month,
                  )}
                </strong>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                    className="cursor-pointer rounded-sm p-1.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                    aria-label="Previous month"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                    className="cursor-pointer rounded-sm p-1.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                    aria-label="Next month"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                  <span key={day} className="py-1">
                    {day}
                  </span>
                ))}
                {days.map((day) => (
                  <button
                    type="button"
                    key={day.toISOString()}
                    onClick={() => {
                      onChange(
                        new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).valueOf(),
                      );
                      setOpen(false);
                    }}
                    className={cn(
                      "flex aspect-square cursor-pointer items-center justify-center rounded-sm text-xs hover:bg-foreground/[0.08]",
                      day.getMonth() !== month.getMonth() && "text-muted-foreground/45",
                      sameDay(selected, day) && "bg-accent text-accent-foreground hover:bg-accent",
                    )}
                  >
                    {day.getDate()}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex justify-between border-hairline border-t pt-2">
                <button
                  type="button"
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="cursor-pointer px-2 py-1 text-muted-foreground text-xs hover:text-foreground"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const today = new Date();
                    onChange(
                      new Date(
                        today.getFullYear(),
                        today.getMonth(),
                        today.getDate(),
                        12,
                      ).valueOf(),
                    );
                    setOpen(false);
                  }}
                  className="cursor-pointer px-2 py-1 text-accent text-xs"
                >
                  Today
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function AssigneePicker({
  members,
  selected,
  disabled,
  onChange,
}: {
  members: MentionCandidate[];
  selected: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const floatingRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(() => setOpen(false), floatingRef);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320 });
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = ref.current?.getBoundingClientRect();
      if (trigger)
        setPosition(
          anchoredPosition(trigger, floatingRef.current?.offsetHeight ?? 280, trigger.width),
        );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, ref]);
  const filtered = members.filter((member) =>
    `${member.name} ${member.email}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(event) => {
          if (!open) {
            const rect = event.currentTarget.getBoundingClientRect();
            setPosition(anchoredPosition(rect, 280, rect.width));
          }
          setOpen((current) => !current);
        }}
        className={cn(
          fieldClass,
          "flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 py-2 text-left disabled:cursor-not-allowed",
        )}
      >
        {selected.length ? (
          <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {selected.map((id) => {
              const member = members.find((candidate) => candidate.userId === id);
              return (
                <span
                  key={id}
                  className="flex max-w-full items-center gap-1.5 rounded-full bg-foreground/[0.06] py-1 pr-2.5 pl-1 text-xs"
                >
                  <Avatar member={member} px={20} className="size-5" />
                  <span className="truncate">{member?.name ?? "Former member"}</span>
                </span>
              );
            })}
          </span>
        ) : (
          <span className="text-muted-foreground text-sm">Select assignees</span>
        )}
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={floatingRef}
              className="fixed z-[180] rounded-md border border-hairline bg-surface p-2 shadow-xl"
              style={position}
            >
              <label className="flex h-9 items-center gap-2 rounded-sm border border-hairline bg-background px-3 focus-within:border-foreground/30 focus-within:ring-2 focus-within:ring-ring">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name or email"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </label>
              <div
                role="listbox"
                aria-label="Assignees"
                aria-multiselectable="true"
                className="mt-2 max-h-56 space-y-0.5 overflow-auto"
              >
                {filtered.map((member) => {
                  const checked = selected.includes(member.userId);
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={checked}
                      key={member.userId}
                      onClick={() =>
                        onChange(
                          checked
                            ? selected.filter((id) => id !== member.userId)
                            : [...selected, member.userId],
                        )
                      }
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-foreground/[0.06]",
                        checked && "bg-foreground/[0.05]",
                      )}
                    >
                      <Avatar member={member} px={32} className="size-8" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-sm">{member.name}</span>
                        <span className="block truncate text-muted-foreground text-xs">
                          {member.email}
                        </span>
                      </span>
                      <Check
                        className={cn(
                          "size-4 shrink-0 text-accent transition-opacity",
                          !checked && "opacity-0",
                        )}
                      />
                    </button>
                  );
                })}
                {filtered.length === 0 ? (
                  <p className="px-2 py-6 text-center text-muted-foreground text-sm">
                    No members found
                  </p>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function setYText(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  text.delete(prefix, current.length - prefix - suffix);
  const insert = next.slice(prefix, next.length - suffix);
  if (insert) text.insert(prefix, insert);
}

function replaceArray(array: Y.Array<string>, values: string[]): void {
  array.delete(0, array.length);
  if (values.length > 0) array.insert(0, values);
}

function removeFromOrders(ydoc: Y.Doc, cardId: string): void {
  for (const order of getBoardRoots(ydoc).cardOrder.values()) {
    for (let index = order.length - 1; index >= 0; index -= 1) {
      if (order.get(index) === cardId) order.delete(index, 1);
    }
  }
}

function InlineName({
  value,
  disabled,
  label,
  className,
  onCommit,
  onDraftChange,
}: {
  value: string;
  disabled: boolean;
  label: string;
  className: string;
  onCommit: (value: string) => void;
  onDraftChange?: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const next = draft.trim();
    if (next) onCommit(next);
    else setDraft(value);
  };
  return (
    <input
      value={draft}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => {
        const next = event.target.value.slice(0, 500);
        setDraft(next);
        onDraftChange?.(next);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}

export function BoardEditor({
  ydoc,
  awareness,
  ready,
  canEdit,
  members,
  nodes,
  selectedCardId,
  onSelectionChange,
  onOpenComments,
  onOpenDocument,
}: {
  ydoc: Y.Doc;
  awareness: Awareness;
  ready: boolean;
  canEdit: boolean;
  members: MentionCandidate[];
  nodes: TreeNode[];
  selectedCardId: string | null;
  onSelectionChange: (selection: BoardCardSelection | null) => void;
  onOpenComments: () => void;
  onOpenDocument: (documentId: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [drag, setDrag] = useState<DragState>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [newCardDraft, setNewCardDraft] = useState<NewCardDraft | null>(null);
  const [newColumnName, setNewColumnName] = useState("");

  useEffect(() => {
    const update = () => setRevision((value) => value + 1);
    ydoc.on("update", update);
    awareness.on("change", update);
    return () => {
      ydoc.off("update", update);
      awareness.off("change", update);
    };
  }, [ydoc, awareness]);

  useEffect(
    () => () => awareness.setLocalStateField("boardDescription", null),
    [awareness, detailCardId],
  );

  useEffect(() => {
    void revision;
    if (!selectedCardId) return;
    const element = document.querySelector<HTMLElement>(`[data-board-card="${selectedCardId}"]`);
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedCardId, revision]);

  const model = (() => {
    void revision;
    if (!ready) return null;
    try {
      const roots = getBoardRoots(ydoc);
      const inspection = inspectBoard(ydoc);
      const columns = inspection.columns.map((id) => ({
        id,
        name: String(roots.columnMeta.get(id)?.get("name") ?? "Untitled"),
        color: String(
          roots.columnMeta.get(id)?.get("color") ?? boardColor(inspection.columns.indexOf(id)),
        ),
        cards: orderedCards(roots, inspection, id),
      }));
      const unfiled = orderedCards(roots, inspection, UNFILED_COLUMN_ID);
      return { roots, inspection, columns, unfiled };
    } catch {
      return null;
    }
  })();

  const remoteStates = [...awareness.getStates().entries()]
    .filter(([clientId]) => clientId !== awareness.clientID)
    .map(([, state]) => state);
  const remoteForCard = (cardId: string) =>
    remoteStates.filter(
      (state) => state.boardCard?.cardId === cardId || state.boardDrag?.cardId === cardId,
    );

  const selectCard = (cardId: string, title: string) => {
    onSelectionChange({ cardId, quote: title });
    awareness.setLocalStateField("boardCard", { cardId });
  };

  const startDrag = (next: DragState) => {
    setDrag(next);
    awareness.setLocalStateField(
      "boardDrag",
      next?.kind === "card"
        ? { kind: "card", cardId: next.id, columnId: next.fromColumnId }
        : next?.kind === "column"
          ? { kind: "column", columnId: next.id }
          : null,
    );
  };

  const finishDrag = () => {
    setDrag(null);
    awareness.setLocalStateField("boardDrag", null);
  };

  const announceDropTarget = (columnId: string, beforeCardId?: string) => {
    if (drag?.kind !== "card") return;
    awareness.setLocalStateField("boardDrag", {
      cardId: drag.id,
      kind: "card",
      columnId: drag.fromColumnId,
      targetColumnId: columnId,
      beforeCardId: beforeCardId ?? null,
    });
  };

  const moveCard = (cardId: string, targetColumnId: string, beforeCardId?: string) => {
    if (!canEdit || !model) return;
    const card = model.roots.cards.get(cardId);
    const target = model.roots.cardOrder.get(targetColumnId);
    if (!card || !target) return;
    ydoc.transact(() => {
      removeFromOrders(ydoc, cardId);
      card.set("columnId", targetColumnId);
      const index = beforeCardId ? target.toArray().indexOf(beforeCardId) : -1;
      target.insert(index >= 0 ? index : target.length, [cardId]);
    }, "board-move");
    finishDrag();
  };

  const moveColumn = (columnId: string, beforeColumnId?: string) => {
    if (!canEdit || !model || columnId === beforeColumnId) return;
    ydoc.transact(() => {
      const columns = model.roots.columns;
      const source = columns.toArray().indexOf(columnId);
      if (source < 0) return;
      columns.delete(source, 1);
      const target = beforeColumnId ? columns.toArray().indexOf(beforeColumnId) : -1;
      columns.insert(target >= 0 ? target : columns.length, [columnId]);
    }, "board-move");
    finishDrag();
  };

  const addCard = (columnId: string) => {
    if (!canEdit || !model) return;
    if (model.inspection.cards.size >= MAX_BOARD_CARDS) {
      notify.error("Card limit reached", {
        description: `A board can contain up to ${MAX_BOARD_CARDS} cards.`,
      });
      return;
    }
    setNewCardDraft({
      title: "Untitled card",
      description: "",
      assignees: [],
      labels: [],
      due: null,
      linkedDocId: null,
      columnId,
      color: boardColorForId(boardId()),
      priority: null,
    });
  };

  const commitNewCard = () => {
    if (!newCardDraft || !model) return;
    const title = newCardDraft.title.trim();
    if (!title) {
      notify.error("Card title required");
      return;
    }
    if (model.inspection.cards.size >= MAX_BOARD_CARDS) {
      notify.error("Card limit reached", {
        description: `A board can contain up to ${MAX_BOARD_CARDS} cards.`,
      });
      return;
    }
    const columnId = model.inspection.columnSet.has(newCardDraft.columnId)
      ? newCardDraft.columnId
      : model.inspection.columns[0];
    const order = columnId ? model.roots.cardOrder.get(columnId) : null;
    if (!columnId || !order) {
      notify.error("Create a column first");
      return;
    }
    const id = boardId();
    ydoc.transact(() => {
      const card = createBoardCard(columnId, title, newCardDraft.color);
      card.set("due", newCardDraft.due);
      card.set("linkedDocId", newCardDraft.linkedDocId);
      card.set("priority", newCardDraft.priority);
      model.roots.cards.set(id, card);
      const live = model.roots.cards.get(id);
      if (live) {
        const description = live.get("description");
        const assignees = live.get("assignees");
        const labels = live.get("labels");
        if (description instanceof Y.Text && newCardDraft.description)
          description.insert(0, newCardDraft.description);
        if (assignees instanceof Y.Array && newCardDraft.assignees.length > 0)
          assignees.insert(0, newCardDraft.assignees);
        if (labels instanceof Y.Array && newCardDraft.labels.length > 0)
          labels.insert(0, newCardDraft.labels);
      }
      order.push([id]);
    }, "board-edit");
    selectCard(id, title);
    setNewCardDraft(null);
  };

  const addColumn = () => {
    if (!canEdit || !model || !newColumnName.trim()) return;
    if (model.inspection.columns.length >= MAX_BOARD_COLUMNS) {
      notify.error("Column limit reached", {
        description: `A board can contain up to ${MAX_BOARD_COLUMNS} columns.`,
      });
      return;
    }
    const id = boardId();
    const usedColors = new Set(model.columns.map((column) => column.color));
    const color =
      Array.from({ length: 8 }, (_, index) => boardColor(index)).find(
        (candidate) => !usedColors.has(candidate),
      ) ?? boardColorForId(id);
    ydoc.transact(() => {
      model.roots.columns.push([id]);
      const meta = new Y.Map<unknown>();
      meta.set("name", newColumnName.trim().slice(0, 120));
      meta.set("color", color);
      model.roots.columnMeta.set(id, meta);
      model.roots.cardOrder.set(id, new Y.Array<string>());
    }, "board-edit");
    setNewColumnName("");
  };

  const deleteColumn = (columnId: string) => {
    if (
      !canEdit ||
      !model ||
      !window.confirm("Delete this column? Its cards will move to Unfiled.")
    )
      return;
    const unfiled = model.roots.cardOrder.get(UNFILED_COLUMN_ID);
    const cards = orderedCards(model.roots, model.inspection, columnId);
    ydoc.transact(() => {
      for (const card of cards) {
        removeFromOrders(ydoc, card.id);
        model.roots.cards.get(card.id)?.set("columnId", UNFILED_COLUMN_ID);
        unfiled?.push([card.id]);
      }
      const index = model.roots.columns.toArray().indexOf(columnId);
      if (index >= 0) model.roots.columns.delete(index, 1);
    }, "board-edit");
  };

  const detailCard = detailCardId && model ? model.inspection.cards.get(detailCardId) : null;
  const activeCard = detailCard ?? newCardDraft;
  const descriptionEditors = detailCard
    ? remoteStates.filter((state) => state.boardDescription?.cardId === detailCard.id)
    : [];
  const memberById = new Map(members.map((member) => [member.userId, member]));
  const linkedFiles = nodes.filter((node) => node.kind === "file");

  if (!ready || !model) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Preparing board…
      </div>
    );
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label="Kanban board editor"
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {model.columns.map((column) => (
          <fieldset
            key={column.id}
            className="flex w-72 shrink-0 flex-col rounded-lg border border-hairline bg-surface/65"
            style={{
              ...(remoteStates.find(
                (state) =>
                  state.boardDrag?.kind === "column" && state.boardDrag?.columnId === column.id,
              )?.user?.color
                ? {
                    boxShadow: `0 0 0 2px ${remoteStates.find((state) => state.boardDrag?.kind === "column" && state.boardDrag?.columnId === column.id)?.user?.color}`,
                  }
                : {}),
            }}
            onDragOver={(event) => {
              event.preventDefault();
              announceDropTarget(column.id);
            }}
            onDrop={() => {
              if (drag?.kind === "card") moveCard(drag.id, column.id);
              if (drag?.kind === "column") moveColumn(drag.id, column.id);
            }}
          >
            <header className="flex items-center gap-1 border-hairline border-b p-2">
              <button
                type="button"
                draggable={canEdit}
                onDragStart={() => startDrag({ kind: "column", id: column.id })}
                onDragEnd={finishDrag}
                className="cursor-grab p-1 text-muted-foreground active:cursor-grabbing"
                aria-label={`Move ${column.name} column`}
              >
                <GripVertical className="size-4" />
              </button>
              {canEdit ? (
                <ColorPicker
                  compact
                  label={`Change ${column.name} color`}
                  value={column.color}
                  disabled={!canEdit}
                  onChange={(value) => model.roots.columnMeta.get(column.id)?.set("color", value)}
                />
              ) : (
                <span
                  className="size-4 shrink-0 rounded-sm"
                  style={{ backgroundColor: column.color }}
                />
              )}
              <InlineName
                key={`${column.id}:${column.name}`}
                value={column.name}
                disabled={!canEdit}
                label="Column name"
                onCommit={(value) =>
                  model.roots.columnMeta.get(column.id)?.set("name", value.slice(0, 120))
                }
                className="min-w-0 flex-1 bg-transparent px-1 font-medium text-sm outline-none"
              />
              <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                {column.cards.length}
              </span>
              {canEdit ? (
                <>
                  <button
                    type="button"
                    disabled={model.inspection.columns[0] === column.id}
                    onClick={() => {
                      const index = model.inspection.columns.indexOf(column.id);
                      moveColumn(column.id, model.inspection.columns[index - 1]);
                    }}
                    className="cursor-pointer p-1 text-muted-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    aria-label={`Move ${column.name} left`}
                  >
                    <ArrowLeft className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={model.inspection.columns.at(-1) === column.id}
                    onClick={() => {
                      const columns = model.inspection.columns;
                      const index = columns.indexOf(column.id);
                      const afterNext = columns[index + 2];
                      moveColumn(column.id, afterNext);
                    }}
                    className="cursor-pointer p-1 text-muted-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    aria-label={`Move ${column.name} right`}
                  >
                    <ArrowRight className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteColumn(column.id)}
                    className="cursor-pointer rounded-sm p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Delete ${column.name} column`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </>
              ) : null}
            </header>
            <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {remoteStates
                .filter((state) => state.boardDrag?.targetColumnId === column.id)
                .map((state) => (
                  <div
                    key={state.user?.sessionId ?? state.user?.name}
                    className="rounded-sm border border-dashed px-2 py-1 text-[10px]"
                    style={{ borderColor: state.user?.color, color: state.user?.color }}
                  >
                    {state.user?.name} is moving a card here
                  </div>
                ))}
              {column.cards.map((card) => {
                const remote = remoteForCard(card.id);
                const due = card.due ? cardDueDetails(card.due) : null;
                const assignees = card.assignees.map((id) => memberById.get(id));
                const linkedDocument = card.linkedDocId
                  ? linkedFiles.find((node) => node.id === card.linkedDocId)
                  : null;
                return (
                  <button
                    type="button"
                    key={card.id}
                    data-board-card={card.id}
                    draggable={canEdit}
                    onDragStart={() =>
                      startDrag({ kind: "card", id: card.id, fromColumnId: column.id })
                    }
                    onDragOver={(event) => {
                      event.preventDefault();
                      announceDropTarget(column.id, card.id);
                    }}
                    onDrop={(event) => {
                      event.stopPropagation();
                      if (drag?.kind === "card") moveCard(drag.id, column.id, card.id);
                    }}
                    onClick={() => selectCard(card.id, card.title)}
                    onDoubleClick={() => setDetailCardId(card.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectCard(card.id, card.title);
                        setDetailCardId(card.id);
                      }
                    }}
                    onDragEnd={finishDrag}
                    className={cn(
                      "group w-full cursor-pointer rounded-lg border p-3 text-left shadow-sm transition-all hover:shadow-md",
                      selectedCardId === card.id
                        ? "bg-foreground/[0.04]"
                        : "bg-surface hover:bg-foreground/[0.02]",
                    )}
                    style={{
                      borderColor: `${card.color}99`,
                      ...(remote[0]?.user?.color
                        ? { boxShadow: `0 0 0 2px ${remote[0].user.color}` }
                        : selectedCardId === card.id
                          ? { boxShadow: `0 0 0 1px ${card.color}` }
                          : {}),
                    }}
                  >
                    {card.priority || card.labels.length > 0 ? (
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        {card.priority ? (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-semibold text-[10px] uppercase tracking-wide",
                              PRIORITIES.find((item) => item.value === card.priority)?.className,
                            )}
                          >
                            <span className="size-1.5 rounded-full bg-current" />
                            {card.priority}
                          </span>
                        ) : null}
                        {card.labels.flatMap((labelId) => {
                          const meta = model.roots.labelMeta.get(labelId);
                          return meta ? (
                            <span
                              key={labelId}
                              className="rounded-full px-2 py-0.5 font-medium text-[10px]"
                              style={{
                                backgroundColor: `${String(meta.get("color"))}22`,
                                color: String(meta.get("color")),
                              }}
                            >
                              {String(meta.get("name"))}
                            </span>
                          ) : (
                            []
                          );
                        })}
                      </div>
                    ) : null}
                    <h3 className="line-clamp-2 break-words font-semibold text-foreground text-sm leading-snug">
                      {card.title}
                    </h3>
                    {card.description ? (
                      <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words text-muted-foreground text-xs leading-relaxed">
                        {card.description}
                      </p>
                    ) : null}
                    {due || assignees.length > 0 || card.linkedDocId || remote.length > 0 ? (
                      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-hairline border-t pt-2.5">
                        {due ? (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium text-[10px]",
                              due.className,
                            )}
                          >
                            <CalendarDays className="size-3" />
                            {due.label}
                          </span>
                        ) : null}
                        {card.linkedDocId ? (
                          <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-hairline bg-foreground/[0.04] px-2 py-0.5 text-[10px] text-muted-foreground">
                            <Link2 className="size-3 shrink-0" />
                            <span className="truncate">
                              {linkedDocument?.name ?? "Removed document"}
                            </span>
                          </span>
                        ) : null}
                        {assignees.length > 0 ? (
                          <div className="w-full space-y-1.5">
                            {assignees.slice(0, 3).map((member, index) => (
                              <span
                                key={card.assignees[index]}
                                className="flex min-w-0 items-center gap-2"
                              >
                                <Avatar member={member} px={24} className="size-6" />
                                <span className="min-w-0 leading-tight">
                                  <span className="block truncate text-xs">
                                    {member?.name ?? "Former member"}
                                  </span>
                                  <span className="block truncate text-[10px] text-muted-foreground">
                                    {member?.email ?? "No longer in this project"}
                                  </span>
                                </span>
                              </span>
                            ))}
                            {assignees.length > 3 ? (
                              <span className="block pl-8 text-[10px] text-muted-foreground">
                                +{assignees.length - 3} more assignee
                                {assignees.length - 3 === 1 ? "" : "s"}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {remote.length > 0 ? (
                          <span
                            className="w-full truncate text-[10px]"
                            style={{ color: remote[0]?.user?.color }}
                          >
                            {remote[0]?.user?.name} is viewing
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </button>
                );
              })}
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => addCard(column.id)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-muted-foreground text-xs hover:bg-foreground/[0.04] hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                  Add card
                </button>
              ) : null}
            </div>
          </fieldset>
        ))}
        {model.unfiled.length > 0 ? (
          <section className="flex w-72 shrink-0 flex-col rounded-lg border border-warning/30 bg-warning/5">
            <header className="flex items-center gap-2 border-warning/20 border-b p-3">
              <ArchiveRestore className="size-4 text-warning" />
              <h2 className="font-medium text-sm">Unfiled</h2>
              <span className="ml-auto font-mono text-[10px]">{model.unfiled.length}</span>
            </header>
            <div className="space-y-2 p-2">
              {model.unfiled.map((card) => (
                <button
                  type="button"
                  key={card.id}
                  data-board-card={card.id}
                  draggable={canEdit}
                  onDragStart={() =>
                    startDrag({ kind: "card", id: card.id, fromColumnId: UNFILED_COLUMN_ID })
                  }
                  onClick={() => selectCard(card.id, card.title)}
                  onDoubleClick={() => setDetailCardId(card.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectCard(card.id, card.title);
                      setDetailCardId(card.id);
                    }
                  }}
                  onDragEnd={finishDrag}
                  className="w-full cursor-pointer rounded-md border border-hairline bg-background p-3 text-left"
                >
                  <h3 className="font-medium text-sm">{card.title}</h3>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Drag to a column to restore
                  </p>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {canEdit ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              addColumn();
            }}
            className="flex w-72 shrink-0 items-start gap-2 rounded-lg border border-hairline border-dashed p-2"
          >
            <input
              value={newColumnName}
              onChange={(event) => setNewColumnName(event.target.value.slice(0, 120))}
              placeholder="New column"
              aria-label="New column name"
              className={`h-9 min-w-0 flex-1 ${fieldClass}`}
            />
            <Button
              type="submit"
              size="icon"
              disabled={!newColumnName.trim()}
              aria-label="Add column"
            >
              <Plus className="size-4" />
            </Button>
          </form>
        ) : null}
      </div>
      {activeCard ? (
        <Dialog
          open
          onClose={() => {
            setDetailCardId(null);
            setNewCardDraft(null);
          }}
          title={activeCard.title}
          icon={<Tag className="size-4" />}
          mobileSheet
          description={
            newCardDraft
              ? "Complete the card details. The card is created only when you select Done."
              : "Edit card details. Changes sync automatically."
          }
          className="max-w-2xl"
          footer={
            <div className="flex w-full justify-between">
              {detailCard ? (
                <Button
                  variant="destructive"
                  disabled={!canEdit}
                  onClick={() => {
                    if (!window.confirm("Delete this card and orphan its comments?")) return;
                    ydoc.transact(() => {
                      removeFromOrders(ydoc, detailCard.id);
                      model.roots.cards.delete(detailCard.id);
                    }, "board-edit");
                    onSelectionChange(null);
                    setDetailCardId(null);
                  }}
                >
                  <Trash2 className="size-4" />
                  Delete
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => setNewCardDraft(null)}>
                  Cancel
                </Button>
              )}
              <div className="flex gap-2">
                {detailCard ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      selectCard(detailCard.id, detailCard.title);
                      onOpenComments();
                    }}
                  >
                    <MessageSquare className="size-4" />
                    Comments
                  </Button>
                ) : null}
                <Button
                  onClick={() => {
                    if (newCardDraft) commitNewCard();
                    else setDetailCardId(null);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          }
        >
          <div className="space-y-4 p-4">
            <div className="block">
              <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                Title
              </span>
              <InlineName
                key={detailCard ? `${detailCard.id}:${detailCard.title}` : "new-card-title"}
                disabled={!canEdit}
                value={activeCard.title}
                label="Card title"
                onCommit={(value) => {
                  const title = value.slice(0, 500);
                  if (detailCard) model.roots.cards.get(detailCard.id)?.set("title", title);
                  else setNewCardDraft((draft) => (draft ? { ...draft, title } : draft));
                }}
                onDraftChange={
                  newCardDraft
                    ? (title) => setNewCardDraft((draft) => (draft ? { ...draft, title } : draft))
                    : undefined
                }
                className={`h-10 w-full ${fieldClass}`}
              />
            </div>
            <label className="block">
              <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                Description
              </span>
              <textarea
                disabled={!canEdit}
                value={activeCard.description}
                onChange={(event) => {
                  const description = event.target.value.slice(0, 64 * 1024);
                  if (detailCard)
                    ydoc.transact(
                      () => setYText(detailCard.descriptionText, description),
                      "board-edit",
                    );
                  else setNewCardDraft((draft) => (draft ? { ...draft, description } : draft));
                }}
                onFocus={(event) => {
                  if (!detailCard) return;
                  awareness.setLocalStateField("boardDescription", {
                    cardId: detailCard.id,
                    anchor: event.currentTarget.selectionStart,
                    head: event.currentTarget.selectionEnd,
                  });
                }}
                onSelect={(event) => {
                  if (!detailCard) return;
                  awareness.setLocalStateField("boardDescription", {
                    cardId: detailCard.id,
                    anchor: event.currentTarget.selectionStart,
                    head: event.currentTarget.selectionEnd,
                  });
                }}
                onBlur={() => awareness.setLocalStateField("boardDescription", null)}
                className={`min-h-40 w-full resize-y py-3 leading-relaxed ${fieldClass}`}
                placeholder="Write a Markdown description…"
              />
              {descriptionEditors.length > 0 ? (
                <span className="mt-1.5 flex flex-wrap gap-2 text-[10px]">
                  {descriptionEditors.map((state) => (
                    <span
                      key={state.user?.sessionId ?? state.user?.name}
                      style={{ color: state.user?.color }}
                    >
                      {state.user?.name} editing at character{" "}
                      {Number(state.boardDescription?.head ?? 0) + 1}
                    </span>
                  ))}
                </span>
              ) : null}
            </label>
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <div>
                <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                  Card color
                </span>
                <ColorPicker
                  label="Change card color"
                  disabled={!canEdit}
                  value={activeCard.color}
                  onChange={(value) => {
                    if (detailCard) model.roots.cards.get(detailCard.id)?.set("color", value);
                    else setNewCardDraft((draft) => (draft ? { ...draft, color: value } : draft));
                  }}
                />
              </div>
              <fieldset disabled={!canEdit}>
                <legend className="mb-1.5 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                  Urgency
                </legend>
                <div className="grid grid-cols-3 gap-1 rounded-md border border-hairline p-1 sm:h-11 sm:grid-cols-5">
                  <button
                    type="button"
                    onClick={() => {
                      if (detailCard) model.roots.cards.get(detailCard.id)?.set("priority", null);
                      else
                        setNewCardDraft((draft) => (draft ? { ...draft, priority: null } : draft));
                    }}
                    className={cn(
                      "h-9 cursor-pointer truncate rounded-sm px-2 font-medium text-sm transition-colors disabled:cursor-not-allowed sm:h-full",
                      !activeCard.priority
                        ? "bg-foreground/[0.08] text-foreground"
                        : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
                    )}
                  >
                    None
                  </button>
                  {PRIORITIES.map((priority) => (
                    <button
                      type="button"
                      key={priority.value}
                      onClick={() => {
                        if (detailCard)
                          model.roots.cards.get(detailCard.id)?.set("priority", priority.value);
                        else
                          setNewCardDraft((draft) =>
                            draft ? { ...draft, priority: priority.value } : draft,
                          );
                      }}
                      className={cn(
                        "h-9 cursor-pointer truncate rounded-sm border border-transparent px-2 font-medium text-sm transition-colors disabled:cursor-not-allowed sm:h-full",
                        activeCard.priority === priority.value
                          ? priority.className
                          : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
                      )}
                    >
                      {priority.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="block">
                <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                  Column
                </span>
                <SelectMenu
                  label="Column"
                  disabled={!canEdit}
                  value={activeCard.columnId}
                  options={[
                    ...model.columns.map((column) => ({ value: column.id, label: column.name })),
                    ...(activeCard.columnId === UNFILED_COLUMN_ID
                      ? [{ value: UNFILED_COLUMN_ID, label: "Unfiled" }]
                      : []),
                  ]}
                  onChange={(value) => {
                    if (detailCard) moveCard(detailCard.id, value);
                    else
                      setNewCardDraft((draft) => (draft ? { ...draft, columnId: value } : draft));
                  }}
                />
              </div>
              <div className="block">
                <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                  Due date
                </span>
                <DatePicker
                  disabled={!canEdit}
                  value={activeCard.due}
                  onChange={(value) => {
                    if (detailCard) model.roots.cards.get(detailCard.id)?.set("due", value);
                    else setNewCardDraft((draft) => (draft ? { ...draft, due: value } : draft));
                  }}
                />
              </div>
              <div className="block sm:col-span-2">
                <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                  Linked document
                </span>
                <div className="flex gap-2">
                  <div className="min-w-0 flex-1">
                    <SelectMenu
                      label="Linked document"
                      disabled={!canEdit}
                      value={activeCard.linkedDocId ?? ""}
                      onChange={(value) => {
                        const linkedDocId = value || null;
                        if (detailCard)
                          model.roots.cards.get(detailCard.id)?.set("linkedDocId", linkedDocId);
                        else
                          setNewCardDraft((draft) => (draft ? { ...draft, linkedDocId } : draft));
                      }}
                      options={[
                        { value: "", label: "None" },
                        ...(activeCard.linkedDocId &&
                        !linkedFiles.some((node) => node.id === activeCard.linkedDocId)
                          ? [{ value: activeCard.linkedDocId, label: "Removed document" }]
                          : []),
                        ...linkedFiles.map((node) => ({ value: node.id, label: node.name })),
                      ]}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    disabled={
                      !activeCard.linkedDocId ||
                      !linkedFiles.some((node) => node.id === activeCard.linkedDocId)
                    }
                    onClick={() => {
                      if (activeCard.linkedDocId) onOpenDocument(activeCard.linkedDocId);
                    }}
                    aria-label="Open linked document"
                  >
                    <Link2 className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
            <div>
              <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                Assignees
              </span>
              <AssigneePicker
                members={members}
                selected={activeCard.assignees}
                disabled={!canEdit}
                onChange={(values) => {
                  if (detailCard) {
                    const array = model.roots.cards.get(detailCard.id)?.get("assignees");
                    if (array instanceof Y.Array) replaceArray(array, values);
                  } else {
                    setNewCardDraft((draft) => (draft ? { ...draft, assignees: values } : draft));
                  }
                }}
              />
              {activeCard.assignees.some((id) => !memberById.has(id)) ? (
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Includes a former member.
                </p>
              ) : null}
            </div>
            <fieldset disabled={!canEdit}>
              <legend className="mb-1.5 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                Labels
              </legend>
              <div className="flex flex-wrap gap-2">
                {[...model.roots.labelMeta.entries()].map(([id, meta]) => {
                  const checked = activeCard.labels.includes(id);
                  return (
                    <label
                      key={id}
                      className="flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1 text-xs"
                      style={{
                        backgroundColor: `${String(meta.get("color"))}22`,
                        color: String(meta.get("color")),
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        className="cursor-pointer"
                        onChange={() => {
                          const labels = checked
                            ? activeCard.labels.filter((value) => value !== id)
                            : [...activeCard.labels, id];
                          if (detailCard) {
                            const array = model.roots.cards.get(detailCard.id)?.get("labels");
                            if (array instanceof Y.Array) replaceArray(array, labels);
                          } else {
                            setNewCardDraft((draft) => (draft ? { ...draft, labels } : draft));
                          }
                        }}
                      />
                      {String(meta.get("name"))}
                    </label>
                  );
                })}
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => {
                    if (model.roots.labelMeta.size >= MAX_BOARD_LABELS) {
                      notify.error("Label limit reached", {
                        description: `A board can contain up to ${MAX_BOARD_LABELS} labels.`,
                      });
                      return;
                    }
                    const name = window.prompt("Label name");
                    if (!name?.trim()) return;
                    const id = boardId();
                    const meta = new Y.Map<unknown>();
                    meta.set("name", name.trim().slice(0, 80));
                    meta.set(
                      "color",
                      LABEL_COLORS[model.roots.labelMeta.size % LABEL_COLORS.length],
                    );
                    model.roots.labelMeta.set(id, meta);
                  }}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-hairline border-dashed px-2 py-1 text-muted-foreground text-xs disabled:cursor-not-allowed"
                >
                  <Plus className="size-3" />
                  Label
                </button>
              </div>
            </fieldset>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
