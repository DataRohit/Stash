"use client";

import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { anchoredPosition, useOutsideClose } from "@/components/ui/floating";
import { fieldClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

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

export function ColorPicker({
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
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = ref.current?.getBoundingClientRect();
      if (trigger)
        setPosition(
          anchoredPosition(trigger, floatingRef.current?.offsetHeight ?? 280, 256, "start"),
        );
    };
    update();
  }, [open, ref]);
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = ref.current?.getBoundingClientRect();
      if (trigger)
        setPosition(
          anchoredPosition(trigger, floatingRef.current?.offsetHeight ?? 280, 256, "start"),
        );
    };
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
