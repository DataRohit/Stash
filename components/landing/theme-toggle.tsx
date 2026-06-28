"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import type { MouseEvent } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void> };
};

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  const handleToggle = (event: MouseEvent<HTMLButtonElement>) => {
    const next = resolvedTheme === "dark" ? "light" : "dark";
    const doc = document as DocumentWithViewTransition;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!doc.startViewTransition || prefersReduced) {
      setTheme(next);
      return;
    }

    const x = event.clientX;
    const y = event.clientY;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = doc.startViewTransition(() => {
      flushSync(() => setTheme(next));
    });

    transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`],
        },
        {
          duration: 450,
          easing: "ease-in-out",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    });
  };

  return (
    <Button variant="secondary" size="icon" aria-label="Toggle color theme" onClick={handleToggle}>
      <Sun className="hidden size-4 dark:block" />
      <Moon className="block size-4 dark:hidden" />
    </Button>
  );
}
