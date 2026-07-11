"use client";

import { X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  className,
  initialFocusRef,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(
      () => (initialFocusRef?.current ?? closeRef.current)?.focus(),
      0,
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) {
        return;
      }
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [initialFocusRef, onClose, open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        aria-label={`Close ${title}`}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          "glass-strong relative flex max-h-[min(88dvh,760px)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-hairline shadow-[var(--shadow-glass)]",
          className,
        )}
      >
        <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-hairline border-b px-3 py-2">
          <h2
            id={titleId}
            className="flex min-w-0 items-center gap-2 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest"
          >
            {icon}
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {description ? (
          <p
            id={descriptionId}
            className="shrink-0 border-hairline border-b px-3 py-2 text-[11px] text-muted-foreground leading-relaxed"
          >
            {description}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer ? <div className="shrink-0 border-hairline border-t p-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
