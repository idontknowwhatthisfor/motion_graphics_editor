import type { Ease } from "./types";

/**
 * Easing presets. Every preset is a plain cubic-bezier so the graph editor
 * can show and edit its handles (ED-06, ED-07). Overshoot presets use y
 * values outside [0, 1].
 */
export const EASE_PRESETS = {
  linear: { kind: "linear" },
  hold: { kind: "hold" },
  easeIn: { kind: "bezier", x1: 0.42, y1: 0, x2: 1, y2: 1 },
  easeOut: { kind: "bezier", x1: 0, y1: 0, x2: 0.58, y2: 1 },
  easeInOut: { kind: "bezier", x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  easeOutCubic: { kind: "bezier", x1: 0.33, y1: 1, x2: 0.68, y2: 1 },
  easeInCubic: { kind: "bezier", x1: 0.32, y1: 0, x2: 0.67, y2: 0 },
  easeInOutCubic: { kind: "bezier", x1: 0.65, y1: 0, x2: 0.35, y2: 1 },
  easeOutExpo: { kind: "bezier", x1: 0.16, y1: 1, x2: 0.3, y2: 1 },
  easeInOutExpo: { kind: "bezier", x1: 0.87, y1: 0, x2: 0.13, y2: 1 },
  easeOutBack: { kind: "bezier", x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
  easeInBack: { kind: "bezier", x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 },
  easeInOutBack: { kind: "bezier", x1: 0.68, y1: -0.6, x2: 0.32, y2: 1.6 },
} as const satisfies Record<string, Ease>;

export type EasePresetName = keyof typeof EASE_PRESETS;
export const EASE_PRESET_NAMES = Object.keys(EASE_PRESETS) as EasePresetName[];

export function easePreset(name: EasePresetName): Ease {
  return { ...EASE_PRESETS[name] } as Ease;
}

/** Find the preset name matching an ease, if any. */
export function easeName(e: Ease): EasePresetName | "custom" {
  for (const n of EASE_PRESET_NAMES) {
    const p = EASE_PRESETS[n] as Ease;
    if (p.kind !== e.kind) continue;
    if (p.kind !== "bezier") return n;
    const b = e as Extract<Ease, { kind: "bezier" }>;
    if (
      Math.abs(p.x1 - b.x1) < 1e-6 &&
      Math.abs(p.y1 - b.y1) < 1e-6 &&
      Math.abs(p.x2 - b.x2) < 1e-6 &&
      Math.abs(p.y2 - b.y2) < 1e-6
    )
      return n;
  }
  return "custom";
}

/**
 * Evaluate a CSS cubic-bezier(x1,y1,x2,y2) at progress x in [0,1].
 * Newton-Raphson with a bisection fallback, accurate to ~1e-7.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-7) return sampleY(t);
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 40; i++) {
    const v = sampleX(t);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

/** Apply an ease to linear progress u in [0,1]. */
export function applyEase(e: Ease, u: number): number {
  switch (e.kind) {
    case "linear":
      return u;
    case "hold":
      return 0;
    case "bezier":
      return cubicBezier(e.x1, e.y1, e.x2, e.y2, u);
  }
}
