"use client";

import { X } from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
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
  mobileSheet?: boolean;
};

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
  mobileSheet = false,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useDialogA11y({
    open,
    onClose,
    containerRef: panelRef,
    initialFocusRef: initialFocusRef ?? closeRef,
  });

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[120] flex justify-center",
        mobileSheet ? "items-end p-0 sm:items-center sm:p-4" : "items-center p-3 sm:p-4",
      )}
    >
      <button
        type="button"
        aria-label={`Close ${title}`}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          "glass-strong relative flex max-h-[min(88dvh,760px)] w-full max-w-lg flex-col overflow-hidden border border-hairline shadow-[var(--shadow-glass)]",
          mobileSheet ? "h-[min(82dvh,760px)] rounded-t-lg sm:h-auto sm:rounded-lg" : "rounded-lg",
          className,
        )}
      >
        {mobileSheet ? (
          <div
            className="flex h-5 shrink-0 items-center justify-center sm:hidden"
            aria-hidden="true"
          >
            <span className="h-1 w-10 rounded-full bg-foreground/20" />
          </div>
        ) : null}
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
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive sm:size-7"
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
