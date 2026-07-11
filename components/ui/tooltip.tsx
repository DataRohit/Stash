"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function TooltipProvider() {
  const [tip, setTip] = useState<{ label: string; left: number; top: number } | null>(null);
  const providerTimer = useRef<number | null>(null);

  useEffect(() => {
    const controlFor = (target: EventTarget | null) =>
      target instanceof Element
        ? target.closest<HTMLElement>(
            "button[aria-label],a[aria-label],[role='button'][aria-label]",
          )
        : null;
    const clear = () => {
      if (providerTimer.current !== null) {
        window.clearTimeout(providerTimer.current);
        providerTimer.current = null;
      }
      setTip(null);
    };
    const show = (target: EventTarget | null, delay: number) => {
      const element = controlFor(target);
      const label = element?.getAttribute("aria-label")?.trim();
      if (!element || !label) return;
      clear();
      providerTimer.current = window.setTimeout(() => {
        const rect = element.getBoundingClientRect();
        setTip({
          label,
          left: Math.min(window.innerWidth - 12, Math.max(12, rect.left + rect.width / 2)),
          top: Math.min(window.innerHeight - 36, rect.bottom + 8),
        });
      }, delay);
    };
    const pointerOver = (event: PointerEvent) => show(event.target, 550);
    const pointerOut = (event: PointerEvent) => {
      if (controlFor(event.target) !== controlFor(event.relatedTarget)) {
        clear();
      }
    };
    const focusIn = (event: Event) => show(event.target, 150);
    const keyDown = (event: KeyboardEvent) => event.key === "Escape" && clear();
    document.addEventListener("pointerover", pointerOver);
    document.addEventListener("pointerout", pointerOut);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", clear);
    document.addEventListener("keydown", keyDown);
    return () => {
      clear();
      document.removeEventListener("pointerover", pointerOver);
      document.removeEventListener("pointerout", pointerOut);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", clear);
      document.removeEventListener("keydown", keyDown);
    };
  }, []);

  return tip && typeof document !== "undefined"
    ? createPortal(
        <span
          role="tooltip"
          className="pointer-events-none fixed z-[190] max-w-56 -translate-x-1/2 rounded-sm border border-hairline bg-surface px-2 py-1 font-medium text-[11px] text-foreground shadow-xl"
          style={{ left: tip.left, top: tip.top }}
        >
          {tip.label}
        </span>,
        document.body,
      )
    : null;
}
