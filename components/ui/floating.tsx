"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export function useOutsideClose(
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

export function anchoredPosition(
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

export function useAnchoredPosition({
  open,
  anchorRef,
  floatingRef,
  estimatedHeight = 320,
  requestedWidth,
  align = "start",
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  floatingRef: RefObject<HTMLElement | null>;
  estimatedHeight?: number;
  requestedWidth?: number;
  align?: "start" | "end";
}) {
  const [position, setPosition] = useState({ left: 8, top: 8, width: requestedWidth ?? 240 });
  const updatePosition = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(
      anchoredPosition(
        rect,
        floatingRef.current?.offsetHeight ?? estimatedHeight,
        requestedWidth ?? rect.width,
        align,
      ),
    );
  }, [align, anchorRef, estimatedHeight, floatingRef, requestedWidth]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const observer = new ResizeObserver(updatePosition);
    if (floatingRef.current) observer.observe(floatingRef.current);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [floatingRef, open, updatePosition]);

  return position;
}
