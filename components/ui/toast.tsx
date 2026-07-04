"use client";

import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { toast as sonnerToast } from "sonner";
import { cn } from "@/lib/utils";

type ToastType = "success" | "error" | "warning" | "info";

type ToastOptions = {
  description?: ReactNode;
};

const TYPE_STYLES: Record<
  ToastType,
  { icon: ComponentType<{ className?: string }>; badge: string; iconColor: string }
> = {
  success: {
    icon: CircleCheck,
    badge: "border-success/30 bg-success/10",
    iconColor: "text-success",
  },
  error: {
    icon: CircleAlert,
    badge: "border-destructive/30 bg-destructive/10",
    iconColor: "text-destructive",
  },
  warning: {
    icon: TriangleAlert,
    badge: "border-warning/30 bg-warning/10",
    iconColor: "text-warning",
  },
  info: {
    icon: Info,
    badge: "border-info/30 bg-info/10",
    iconColor: "text-info",
  },
};

function ToastCard({
  id,
  type,
  title,
  description,
}: {
  id: string | number;
  type: ToastType;
  title: string;
  description?: ReactNode;
}) {
  const { icon: Icon, badge, iconColor } = TYPE_STYLES[type];

  return (
    <div className="glass-strong pointer-events-auto flex w-[356px] max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg p-3.5">
      <span
        className={cn("flex size-7 shrink-0 items-center justify-center rounded-md border", badge)}
      >
        <Icon className={cn("size-4", iconColor)} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium font-sans text-foreground text-sm leading-tight">{title}</p>
        {description ? (
          <p className="mt-1 text-muted-foreground text-xs leading-relaxed">{description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => sonnerToast.dismiss(id)}
        aria-label="Dismiss notification"
        className="-mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center self-center rounded-sm text-muted-foreground transition-colors hover:text-destructive"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function show(type: ToastType, title: string, options?: ToastOptions) {
  return sonnerToast.custom((id) => (
    <ToastCard id={id} type={type} title={title} description={options?.description} />
  ));
}

export const notify = {
  success: (title: string, options?: ToastOptions) => show("success", title, options),
  error: (title: string, options?: ToastOptions) => show("error", title, options),
  warning: (title: string, options?: ToastOptions) => show("warning", title, options),
  info: (title: string, options?: ToastOptions) => show("info", title, options),
};
