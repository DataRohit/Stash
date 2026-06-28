"use client";

import { useEffect, useRef } from "react";

const CELL = 36;
const RIPPLE_SETTLE_TIME = 1.45;
const RIPPLE_SPEED = 520;
const RIPPLE_DAMPING = 2.25;
const RIPPLE_FALLOFF = 920;
const RIPPLE_OSCILLATION = 12;

type Cell = {
  gx: number;
  gy: number;
  phase: number;
  speed: number;
};

type Ripple = {
  x: number;
  y: number;
  start: number;
  maxDistance: number;
  duration: number;
};

export function GridBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    let width = 0;
    let height = 0;
    let cells: Cell[] = [];
    let ripples: Ripple[] = [];
    const mouse = { x: -9999, y: -9999, active: false };

    const seed = () => {
      const cols = Math.max(1, Math.ceil(width / CELL));
      const rows = Math.max(1, Math.ceil(height / CELL));
      const count = Math.min(72, Math.max(18, Math.floor(cols * rows * 0.08)));
      cells = Array.from({ length: count }, () => ({
        gx: Math.floor(Math.random() * cols),
        gy: Math.floor(Math.random() * rows),
        phase: Math.random() * Math.PI * 2,
        speed: 0.5 + Math.random() * 1.4,
      }));
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const onMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = event.clientX - rect.left;
      mouse.y = event.clientY - rect.top;
      mouse.active =
        mouse.x >= 0 && mouse.y >= 0 && mouse.x <= rect.width && mouse.y <= rect.height;
    };

    const onLeave = () => {
      mouse.active = false;
    };

    const onClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        return;
      }
      const gx = Math.floor(x / CELL);
      const gy = Math.floor(y / CELL);
      const maxDistance = Math.max(
        Math.hypot(x, y),
        Math.hypot(rect.width - x, y),
        Math.hypot(x, rect.height - y),
        Math.hypot(rect.width - x, rect.height - y),
      );
      ripples = [
        ...ripples.slice(-3),
        {
          x: gx * CELL + CELL / 2,
          y: gy * CELL + CELL / 2,
          start: performance.now(),
          maxDistance,
          duration: maxDistance / RIPPLE_SPEED + RIPPLE_SETTLE_TIME,
        },
      ];
    };

    const tileLift = (gx: number, gy: number, time: number) => {
      let lift = 0;
      const cx = gx * CELL + CELL / 2;
      const cy = gy * CELL + CELL / 2;

      for (const ripple of ripples) {
        const age = (time - ripple.start) / 1000;
        if (age <= 0 || age > ripple.duration) {
          continue;
        }

        const dist = Math.hypot(cx - ripple.x, cy - ripple.y);
        const reachedAt = dist / RIPPLE_SPEED;
        const localAge = age - reachedAt;
        if (localAge < 0) {
          continue;
        }

        const attack = 1 - Math.exp(-localAge * 12);
        const damping = Math.exp(-localAge * RIPPLE_DAMPING) * attack;
        const falloff = Math.exp(-dist / RIPPLE_FALLOFF);
        lift += Math.sin(localAge * RIPPLE_OSCILLATION) * damping * falloff;
      }

      return lift;
    };

    let raf = 0;
    const render = (time: number) => {
      const styles = getComputedStyle(document.documentElement);
      const foreground = styles.getPropertyValue("--foreground").trim();
      const accent = styles.getPropertyValue("--accent").trim();
      ctx.clearRect(0, 0, width, height);
      ripples = ripples.filter((ripple) => (time - ripple.start) / 1000 <= ripple.duration);

      for (const cell of cells) {
        const wave = 0.5 + 0.5 * Math.sin(time * 0.001 * cell.speed + cell.phase);
        ctx.globalAlpha = 0.03 + 0.06 * wave;
        ctx.fillStyle = foreground;
        ctx.fillRect(cell.gx * CELL + 1, cell.gy * CELL + 1, CELL - 1, CELL - 1);
      }

      if (mouse.active) {
        const radius = CELL * 3.2;
        const startX = Math.max(0, Math.floor((mouse.x - radius) / CELL));
        const endX = Math.ceil((mouse.x + radius) / CELL);
        const startY = Math.max(0, Math.floor((mouse.y - radius) / CELL));
        const endY = Math.ceil((mouse.y + radius) / CELL);
        for (let gx = startX; gx <= endX; gx++) {
          for (let gy = startY; gy <= endY; gy++) {
            const dx = gx * CELL + CELL / 2 - mouse.x;
            const dy = gy * CELL + CELL / 2 - mouse.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > radius) {
              continue;
            }
            ctx.globalAlpha = (1 - dist / radius) * 0.16;
            ctx.fillStyle = accent;
            ctx.fillRect(gx * CELL + 1, gy * CELL + 1, CELL - 1, CELL - 1);
          }
        }
      }

      const gridCols = Math.max(1, Math.ceil(width / CELL) + 1);
      const liftedTiles = new Set<number>();
      for (const ripple of ripples) {
        const age = (time - ripple.start) / 1000;
        const radius = Math.min(RIPPLE_SPEED * age + CELL * 2, ripple.maxDistance + CELL * 2);
        const startX = Math.max(0, Math.floor((ripple.x - radius) / CELL));
        const endX = Math.min(Math.ceil(width / CELL), Math.ceil((ripple.x + radius) / CELL));
        const startY = Math.max(0, Math.floor((ripple.y - radius) / CELL));
        const endY = Math.min(Math.ceil(height / CELL), Math.ceil((ripple.y + radius) / CELL));

        for (let gx = startX; gx <= endX; gx++) {
          for (let gy = startY; gy <= endY; gy++) {
            liftedTiles.add(gy * gridCols + gx);
          }
        }
      }

      for (const key of liftedTiles) {
        const gx = key % gridCols;
        const gy = Math.floor(key / gridCols);
        const lift = tileLift(gx, gy, time);
        const strength = Math.min(1, Math.abs(lift));
        if (strength < 0.018) {
          continue;
        }

        const rise = lift * CELL * 0.22;
        const size = CELL - 2 + strength * 4;
        const inset = (CELL - size) / 2;
        const x = gx * CELL + inset;
        const y = gy * CELL + inset - rise;

        ctx.globalAlpha = 0.04 + strength * 0.18;
        ctx.fillStyle = lift > 0 ? accent : foreground;
        ctx.fillRect(x, y, size, size);

        if (lift > 0) {
          ctx.globalAlpha = strength * 0.08;
          ctx.fillStyle = foreground;
          ctx.fillRect(x + 2, y + size, Math.max(0, size - 4), 2);
        }
      }

      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(render);
    };

    resize();
    raf = requestAnimationFrame(render);
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseout", onLeave, { passive: true });
    window.addEventListener("click", onClick, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
      window.removeEventListener("click", onClick);
    };
  }, []);

  return <canvas ref={canvasRef} className="hero-fade absolute inset-0 size-full" />;
}
