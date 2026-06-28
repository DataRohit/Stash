"use client";

import { useEffect, useRef } from "react";

const TWO_PI = Math.PI * 2;
const DOT_RADIUS = 1.35;
const DOT_SPACING = 22;
const CURSOR_RADIUS = 420;
const GLOW_RADIUS = 180;

type Dot = {
  ax: number;
  ay: number;
  sx: number;
  sy: number;
};

type GridBackgroundProps = {
  ripples?: boolean;
};

const drawDot = (ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) => {
  ctx.moveTo(x + radius, y);
  ctx.arc(x, y, radius, 0, TWO_PI);
};

export function GridBackground({ ripples = true }: GridBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) {
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dots: Dot[] = [];
    const mouse = {
      x: -9999,
      y: -9999,
      prevX: -9999,
      prevY: -9999,
      speed: 0,
      active: false,
    };
    const size = { width: 0, height: 0, dpr: 1 };
    let raf = 0;
    let speedTimer = 0;
    let engagement = 0;

    const buildDots = () => {
      dots.length = 0;
      const step = DOT_RADIUS + DOT_SPACING;
      const cols = Math.ceil(size.width / step);
      const rows = Math.ceil(size.height / step);
      const padX = (size.width - (cols - 1) * step) / 2;
      const padY = (size.height - (rows - 1) * step) / 2;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const ax = padX + col * step;
          const ay = padY + row * step;
          dots.push({ ax, ay, sx: ax, sy: ay });
        }
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      size.width = rect.width;
      size.height = rect.height;
      size.dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(size.width * size.dpr);
      canvas.height = Math.floor(size.height * size.dpr);
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      buildDots();
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

    const updateSpeed = () => {
      const dx = mouse.x - mouse.prevX;
      const dy = mouse.y - mouse.prevY;
      const distance = Math.hypot(dx, dy);
      mouse.speed += (distance - mouse.speed) * 0.45;
      if (!mouse.active || mouse.speed < 0.001) {
        mouse.speed = 0;
      }
      mouse.prevX = mouse.x;
      mouse.prevY = mouse.y;
    };

    const render = () => {
      const styles = getComputedStyle(document.documentElement);
      const foreground = styles.getPropertyValue("--foreground").trim();
      const accent = styles.getPropertyValue("--accent").trim();
      const signal = styles.getPropertyValue("--signal").trim();
      const targetEngagement = mouse.active ? Math.min(mouse.speed / 8, 1) : 0;
      const strength = ripples ? 44 : 34;
      engagement += (targetEngagement - engagement) * 0.07;

      ctx.clearRect(0, 0, size.width, size.height);
      ctx.fillStyle = foreground;
      ctx.globalAlpha = 0.16;
      ctx.beginPath();

      for (const dot of dots) {
        const dx = mouse.x - dot.ax;
        const dy = mouse.y - dot.ay;
        const distance = Math.hypot(dx, dy);

        if (mouse.active && distance < CURSOR_RADIUS && engagement > 0.01) {
          const pressure = (1 - distance / CURSOR_RADIUS) ** 2 * strength * engagement;
          const angle = Math.atan2(dy, dx);
          dot.sx += (dot.ax - Math.cos(angle) * pressure - dot.sx) * 0.16;
          dot.sy += (dot.ay - Math.sin(angle) * pressure - dot.sy) * 0.16;
        } else {
          dot.sx += (dot.ax - dot.sx) * 0.1;
          dot.sy += (dot.ay - dot.sy) * 0.1;
        }

        drawDot(ctx, dot.sx, dot.sy, DOT_RADIUS);
      }

      ctx.fill();

      if (mouse.active) {
        const glow = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, GLOW_RADIUS);
        glow.addColorStop(0, accent);
        glow.addColorStop(0.56, signal);
        glow.addColorStop(1, "transparent");
        ctx.globalAlpha = 0.1 + engagement * 0.12;
        ctx.fillStyle = glow;
        ctx.fillRect(
          mouse.x - GLOW_RADIUS,
          mouse.y - GLOW_RADIUS,
          GLOW_RADIUS * 2,
          GLOW_RADIUS * 2,
        );

        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.2 + engagement * 0.18;
        ctx.beginPath();
        for (const dot of dots) {
          const distance = Math.hypot(dot.ax - mouse.x, dot.ay - mouse.y);
          if (distance < CURSOR_RADIUS * 0.42) {
            const pressure = 1 - distance / (CURSOR_RADIUS * 0.42);
            drawDot(ctx, dot.sx, dot.sy, DOT_RADIUS + pressure * 0.9);
          }
        }
        ctx.fill();
      }

      ctx.globalAlpha = 1;

      if (reducedMotion) {
        return;
      }

      raf = requestAnimationFrame(render);
    };

    resize();
    render();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseout", onLeave, { passive: true });
    speedTimer = window.setInterval(updateSpeed, 20);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(speedTimer);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
    };
  }, [ripples]);

  return <canvas ref={canvasRef} className="hero-fade absolute inset-0 size-full" />;
}
