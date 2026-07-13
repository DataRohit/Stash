"use client";

import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

type DialogA11yOptions = {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  lockBody?: boolean;
  trapFocus?: boolean;
};

export function useDialogA11y({
  open,
  onClose,
  containerRef,
  initialFocusRef,
  lockBody = true,
  trapFocus = true,
}: DialogA11yOptions) {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previous = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    if (lockBody) {
      document.body.style.overflow = "hidden";
    }

    const focusInitial = window.setTimeout(() => {
      const firstFocusable = containerRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (initialFocusRef?.current ?? firstFocusable ?? containerRef.current)?.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !trapFocus || !containerRef.current) {
        return;
      }

      const focusable = [...containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.getClientRects().length > 0,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        containerRef.current.focus();
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
      window.clearTimeout(focusInitial);
      if (lockBody) {
        document.body.style.overflow = originalOverflow;
      }
      document.removeEventListener("keydown", onKeyDown);
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [containerRef, initialFocusRef, lockBody, open, trapFocus]);
}
