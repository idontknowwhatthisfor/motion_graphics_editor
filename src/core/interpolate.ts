import { lerpColor } from "./color";
import { applyEase } from "./easing";
import type { AnimValue, Color, Keyframe, PathData, Prop, Vec2 } from "./types";

export function isAnimated(p: Prop): boolean {
  return !!p.keyframes && p.keyframes.length > 0;
}

function isVec2(v: unknown): v is Vec2 {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "number";
}
function isPath(v: unknown): v is PathData {
  return typeof v === "object" && v !== null && "points" in (v as object);
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/** Interpolate between two values with eased progress u. */
export function lerpValue<T extends AnimValue>(a: Keyframe<T>, b: Keyframe<T>, u: number): T {
  const av = a.v as AnimValue;
  const bv = b.v as AnimValue;
  if (typeof av === "number" && typeof bv === "number") return (av + (bv - av) * u) as T;
  if (typeof av === "string" && typeof bv === "string") return lerpColor(av as Color, bv as Color, u) as T;
  if (isVec2(av) && isVec2(bv)) {
    // Motion path: a cubic bezier in space when tangents are present (ED-07).
    if (a.spatialOut || b.spatialIn) {
      const o = a.spatialOut ?? [0, 0];
      const i = b.spatialIn ?? [0, 0];
      return [
        cubic(av[0], av[0] + o[0], bv[0] + i[0], bv[0], u),
        cubic(av[1], av[1] + o[1], bv[1] + i[1], bv[1], u),
      ] as T;
    }
    return [av[0] + (bv[0] - av[0]) * u, av[1] + (bv[1] - av[1]) * u] as T;
  }
  if (isPath(av) && isPath(bv)) {
    if (av.points.length !== bv.points.length) return (u < 1 ? av : bv) as T;
    const l = (x: Vec2, y: Vec2): Vec2 => [x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u];
    return {
      closed: av.closed,
      points: av.points.map((pa, k) => {
        const pb = bv.points[k];
        return { p: l(pa.p, pb.p), in: l(pa.in, pb.in), out: l(pa.out, pb.out) };
      }),
    } as T;
  }
  return (u < 1 ? av : bv) as T;
}

/** Keyframes sorted by time (they are stored sorted; this is defensive). */
function sorted<T extends AnimValue>(kfs: Keyframe<T>[]): Keyframe<T>[] {
  for (let i = 1; i < kfs.length; i++) if (kfs[i].t < kfs[i - 1].t) return [...kfs].sort((x, y) => x.t - y.t);
  return kfs;
}

/**
 * Expressions (ED-12) are applied through a hook that the evaluator installs
 * while it renders a composition, because they need the layer and comp
 * around the property. Outside rendering, valueAt returns the plain value.
 */
export type ExpressionHook = (p: Prop, t: number, base: AnimValue) => AnimValue;
let exprHook: ExpressionHook | null = null;
/** Install a hook; returns the previous one so callers can restore it. */
export function setExpressionHook(h: ExpressionHook | null): ExpressionHook | null {
  const prev = exprHook;
  exprHook = h;
  return prev;
}

/** Value of a property at composition time t (seconds), including its expression while rendering. */
export function valueAt<T extends AnimValue>(p: Prop<T>, t: number): T {
  const v = rawValueAt(p, t);
  return p.expression && exprHook ? (exprHook(p as Prop, t, v) as T) : v;
}

/** Keyframed value only (no expression). */
export function rawValueAt<T extends AnimValue>(p: Prop<T>, t: number): T {
  if (!p.keyframes || p.keyframes.length === 0) return p.value;
  const k = sorted(p.keyframes);
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  // binary search for segment
  let lo = 0;
  let hi = k.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = k[lo];
  const b = k[hi];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = applyEase(a.ease, (t - a.t) / span);
  if (a.ease.kind === "hold") return a.v;
  return lerpValue(a, b, u);
}
