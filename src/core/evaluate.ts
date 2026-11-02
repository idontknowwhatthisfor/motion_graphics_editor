/**
 * Evaluates a composition at a time into a flat, fully resolved scene: every
 * animated property becomes a plain value and every layer gets a world
 * matrix. The renderer (preview AND export) draws only this, which is what
 * keeps the editor preview and the exported video identical.
 */
import { lerpColor } from "./color";
import { ellipseToD, layerMatrix, multiply, pathToD, rectToD, trimDash, type Mat } from "./geometry";
import { valueAt } from "./interpolate";
import type {
  Asset,
  BlendMode,
  Color,
  CombineMode,
  Composition,
  Effect,
  Layer,
  MaskMode,
  MatteMode,
  Paint,
  Project,
  SelectorShape,
  TextAnimator,
  Vec2,
} from "./types";

export type ResolvedPaint =
  | { kind: "solid"; color: Color }
  | { kind: "linear" | "radial"; stops: { offset: number; color: Color }[]; start: Vec2; end: Vec2 };

export interface ResolvedMask {
  id: string;
  d: string;
  mode: MaskMode;
  inverted: boolean;
  opacity: number;
  feather: number;
}

export interface CharState {
  opacity: number; // 0–1 multiplier
  dx: number;
  dy: number;
  sx: number; // multiplier
  sy: number;
  rot: number; // degrees
  fill: Color;
  blur: number;
}

export type ResolvedContent =
  | { type: "solid"; color: Color; width: number; height: number }
  | {
      type: "shape";
      paths: string[];
      combine: CombineMode;
      fill: { paint: ResolvedPaint; opacity: number } | null;
      stroke: {
        paint: ResolvedPaint;
        width: number;
        opacity: number;
        lineCap: string;
        lineJoin: string;
        trim: { dasharray: string; dashoffset: number } | null;
      } | null;
    }
  | {
      type: "text";
      text: string;
      family: string;
      weight: number;
      italic: boolean;
      size: number;
      tracking: number;
      lineHeight: number;
      align: "left" | "center" | "right";
      fill: Color;
      stroke: { color: Color; width: number } | null;
      /** Present when the layer has text animators: one entry per character. */
      chars: CharState[] | null;
    }
  | { type: "image"; src: string; width: number; height: number }
  | { type: "null" }
  | { type: "reference"; src: string; width: number; height: number; mediaTime: number }
  | { type: "precomp"; width: number; height: number; scene: ResolvedScene | null };

export type ResolvedEffect =
  | { kind: "blur"; amount: number }
  | { kind: "glow"; radius: number; intensity: number; color: Color }
  | { kind: "dropShadow"; color: Color; opacity: number; dx: number; dy: number; softness: number }
  | { kind: "colorCorrect"; brightness: number; contrast: number; saturation: number; hue: number }
  | { kind: "gradientOverlay"; gradient: "linear" | "radial"; stops: { offset: number; color: Color }[]; start: Vec2; end: Vec2; opacity: number };

export interface ResolvedLayer {
  id: string;
  name: string;
  matrix: Mat;
  opacity: number; // 0–1
  blendMode: BlendMode;
  masks: ResolvedMask[];
  matte: { layerId: string; mode: MatteMode } | null;
  /** True when another layer uses this one as its track matte. */
  isMatteSource: boolean;
  /** Inside its in/out range and switched on. */
  active: boolean;
  content: ResolvedContent;
  effects: ResolvedEffect[];
}

export interface ResolvedScene {
  width: number;
  height: number;
  background: Color | null;
  time: number;
  /** Bottom-first draw order (reverse of the layer stack). */
  layers: ResolvedLayer[];
}

export interface EvaluateOptions {
  /** Include reference-video layers (true in the editor, false for export). */
  includeReference?: boolean;
  /** Resolve an asset to a URL the renderer can load. */
  assetUrl?: (a: Asset) => string;
  /** Internal: nesting depth for precomps. */
  depth?: number;
}

const MAX_NEST = 8;

export function resolveEffects(effects: Effect[] | undefined, t: number): ResolvedEffect[] {
  const out: ResolvedEffect[] = [];
  for (const e of effects ?? []) {
    if (!e.enabled) continue;
    switch (e.kind) {
      case "blur":
        out.push({ kind: "blur", amount: Math.max(0, valueAt(e.amount, t)) });
        break;
      case "glow":
        out.push({ kind: "glow", radius: Math.max(0, valueAt(e.radius, t)), intensity: Math.max(0, valueAt(e.intensity, t)) / 100, color: valueAt(e.color, t) });
        break;
      case "dropShadow": {
        const a = (valueAt(e.angle, t) * Math.PI) / 180;
        const d = valueAt(e.distance, t);
        out.push({ kind: "dropShadow", color: valueAt(e.color, t), opacity: valueAt(e.opacity, t) / 100, dx: Math.cos(a) * d, dy: Math.sin(a) * d, softness: Math.max(0, valueAt(e.softness, t)) });
        break;
      }
      case "colorCorrect":
        out.push({ kind: "colorCorrect", brightness: valueAt(e.brightness, t), contrast: valueAt(e.contrast, t), saturation: valueAt(e.saturation, t), hue: valueAt(e.hue, t) });
        break;
      case "gradientOverlay":
        out.push({
          kind: "gradientOverlay",
          gradient: e.gradient,
          stops: e.stops.map((st) => ({ offset: st.offset, color: valueAt(st.color, t) })),
          start: valueAt(e.start, t),
          end: valueAt(e.end, t),
          opacity: valueAt(e.opacity, t) / 100,
        });
        break;
    }
  }
  return out;
}

function resolvePaint(p: Paint, t: number): ResolvedPaint {
  if (p.kind === "solid") return { kind: "solid", color: valueAt(p.color, t) };
  return {
    kind: p.kind,
    stops: p.stops.map((s) => ({ offset: s.offset, color: valueAt(s.color, t) })),
    start: valueAt(p.start, t),
    end: valueAt(p.end, t),
  };
}

/** Selection amount 0–1 for unit i of n under a range selector. */
export function selectorAmount(
  shape: SelectorShape,
  startPct: number,
  endPct: number,
  offsetPct: number,
  i: number,
  n: number,
): number {
  if (n <= 0) return 0;
  const s = Math.min(startPct, endPct) / 100 + offsetPct / 100;
  const e = Math.max(startPct, endPct) / 100 + offsetPct / 100;
  const u0 = i / n;
  const u1 = (i + 1) / n;
  if (shape === "square") {
    const overlap = Math.max(0, Math.min(u1, e) - Math.max(u0, s));
    return Math.min(1, overlap / (u1 - u0));
  }
  const c = (u0 + u1) / 2;
  const span = e - s;
  if (shape === "rampUp") {
    if (c <= s) return 0;
    if (c >= e) return 1;
    return (c - s) / span;
  }
  if (shape === "rampDown") {
    if (c <= s) return 1;
    if (c >= e) return 0;
    return 1 - (c - s) / span;
  }
  if (c < s || c > e || span <= 0) return 0;
  const x = (c - s) / span;
  if (shape === "triangle") return 1 - Math.abs(2 * x - 1);
  return (1 - Math.cos(2 * Math.PI * x)) / 2; // smooth
}

function unitIndices(text: string, basedOn: TextAnimator["selector"]["basedOn"]): { idx: number[]; count: number } {
  const chars = Array.from(text);
  if (basedOn === "characters") {
    // spaces/newlines are not counted as units (AE "characters excluding spaces")
    let k = 0;
    const idx = chars.map((ch) => (/\s/.test(ch) ? -1 : k++));
    return { idx, count: k };
  }
  let w = -1;
  let inWord = false;
  const idx = chars.map((ch) => {
    if (/\s/.test(ch)) {
      inWord = false;
      return -1;
    }
    if (!inWord) {
      w++;
      inWord = true;
    }
    return w;
  });
  return { idx, count: w + 1 };
}

export function resolveChars(text: string, base: Color, animators: TextAnimator[], t: number): CharState[] {
  const chars = Array.from(text);
  const out: CharState[] = chars.map(() => ({ opacity: 1, dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, fill: base, blur: 0 }));
  for (const an of animators) {
    const { idx, count } = unitIndices(text, an.selector.basedOn);
    const s = valueAt(an.selector.start, t);
    const e = valueAt(an.selector.end, t);
    const o = valueAt(an.selector.offset, t);
    const P = an.props;
    const op = P.opacity ? valueAt(P.opacity, t) / 100 : null;
    const pos = P.position ? valueAt(P.position, t) : null;
    const sc = P.scale ? valueAt(P.scale, t) : null;
    const rot = P.rotation ? valueAt(P.rotation, t) : null;
    const fc = P.fillColor ? valueAt(P.fillColor, t) : null;
    const bl = P.blur ? valueAt(P.blur, t) : null;
    chars.forEach((_, ci) => {
      const u = idx[ci];
      if (u < 0) return;
      const amt = selectorAmount(an.selector.shape, s, e, o, u, count);
      if (amt <= 0) return;
      const c = out[ci];
      if (op !== null) c.opacity *= 1 + (op - 1) * amt;
      if (pos) {
        c.dx += pos[0] * amt;
        c.dy += pos[1] * amt;
      }
      if (sc) {
        c.sx *= 1 + (sc[0] / 100 - 1) * amt;
        c.sy *= 1 + (sc[1] / 100 - 1) * amt;
      }
      if (rot !== null) c.rot += rot * amt;
      if (fc) c.fill = lerpColor(c.fill, fc, amt);
      if (bl !== null) c.blur += bl * amt;
    });
  }
  return out;
}

type EvalProject = Pick<Project, "assets"> & Partial<Pick<Project, "compositions">>;

/** Prefix nested layer ids so SVG ids stay unique when a comp is reused. */
function prefixScene(scene: ResolvedScene, prefix: string): ResolvedScene {
  return {
    ...scene,
    layers: scene.layers.map((l) => ({ ...l, id: `${prefix}__${l.id}`, matte: l.matte ? { ...l.matte, layerId: `${prefix}__${l.matte.layerId}` } : null })),
  };
}

function resolveContent(layer: Layer, t: number, assets: Map<string, Asset>, assetUrl: (a: Asset) => string, project: EvalProject, opts: EvaluateOptions): ResolvedContent {
  switch (layer.type) {
    case "precomp": {
      const child = project.compositions?.find((c) => c.id === layer.compId);
      if (!child) return { type: "precomp", width: 100, height: 100, scene: null };
      const depth = (opts.depth ?? 0) + 1;
      const ct = t - layer.inPoint + layer.timeOffset;
      const scene =
        depth > MAX_NEST || ct < 0 || ct >= child.duration
          ? null
          : prefixScene(evaluateComposition(project, child, ct, { ...opts, depth }), layer.id);
      return { type: "precomp", width: child.width, height: child.height, scene };
    }
    case "solid":
      return { type: "solid", color: valueAt(layer.color, t), width: layer.width, height: layer.height };
    case "null":
      return { type: "null" };
    case "image": {
      const a = assets.get(layer.assetId);
      return { type: "image", src: a ? assetUrl(a) : "", width: a?.width ?? 100, height: a?.height ?? 100 };
    }
    case "reference": {
      const a = assets.get(layer.assetId);
      return {
        type: "reference",
        src: a ? assetUrl(a) : "",
        width: a?.width ?? 1920,
        height: a?.height ?? 1080,
        mediaTime: Math.max(0, t - layer.inPoint + layer.mediaOffset),
      };
    }
    case "shape": {
      const paths = layer.geometry.map((g) => {
        if (g.kind === "rect") return rectToD(valueAt(g.position, t), valueAt(g.size, t), valueAt(g.roundness, t));
        if (g.kind === "ellipse") return ellipseToD(valueAt(g.position, t), valueAt(g.size, t));
        return pathToD(valueAt(g.path, t));
      });
      const trim = layer.trim.enabled
        ? trimDash(valueAt(layer.trim.start, t), valueAt(layer.trim.end, t), valueAt(layer.trim.offset, t))
        : null;
      return {
        type: "shape",
        paths,
        combine: layer.combine,
        fill: layer.fill.enabled
          ? { paint: resolvePaint(layer.fill.paint, t), opacity: valueAt(layer.fill.opacity, t) / 100 }
          : null,
        stroke: layer.stroke.enabled
          ? {
              paint: resolvePaint(layer.stroke.paint, t),
              width: valueAt(layer.stroke.width, t),
              opacity: valueAt(layer.stroke.opacity, t) / 100,
              lineCap: layer.stroke.lineCap,
              lineJoin: layer.stroke.lineJoin,
              trim,
            }
          : null,
      };
    }
    case "text": {
      const st = layer.style;
      const fill = valueAt(st.fill, t);
      return {
        type: "text",
        text: layer.text,
        family: st.family,
        weight: st.weight,
        italic: st.italic,
        size: valueAt(st.size, t),
        tracking: valueAt(st.tracking, t),
        lineHeight: st.lineHeight,
        align: st.align,
        fill,
        stroke: st.stroke ? { color: valueAt(st.stroke.color, t), width: valueAt(st.stroke.width, t) } : null,
        chars: layer.animators.length ? resolveChars(layer.text, fill, layer.animators, t) : null,
      };
    }
  }
}

/** World matrix of a layer, following its parent chain (ED-04 parenting). */
export function worldMatrix(comp: Composition, layer: Layer, t: number, seen = new Set<string>()): Mat {
  const tr = layer.transform;
  const local = layerMatrix(valueAt(tr.anchor, t), valueAt(tr.position, t), valueAt(tr.scale, t), valueAt(tr.rotation, t));
  if (!layer.parentId || seen.has(layer.id)) return local;
  const parent = comp.layers.find((l) => l.id === layer.parentId);
  if (!parent) return local;
  seen.add(layer.id);
  return multiply(worldMatrix(comp, parent, t, seen), local);
}

export function evaluateComposition(
  project: EvalProject,
  comp: Composition,
  t: number,
  opts: EvaluateOptions = {},
): ResolvedScene {
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const assetUrl = opts.assetUrl ?? ((a: Asset) => a.src);
  const matteSources = new Set(comp.layers.filter((l) => l.matte).map((l) => l.matte!.layerId));
  const layers: ResolvedLayer[] = [];
  for (let i = comp.layers.length - 1; i >= 0; i--) {
    const l = comp.layers[i];
    if (l.type === "reference" && !opts.includeReference) continue;
    layers.push({
      id: l.id,
      name: l.name,
      matrix: worldMatrix(comp, l, t),
      opacity: Math.max(0, Math.min(1, valueAt(l.transform.opacity, t) / 100)),
      blendMode: l.blendMode,
      masks: l.masks.map((m) => ({
        id: m.id,
        d: pathToD(valueAt(m.path, t)),
        mode: m.mode,
        inverted: m.inverted,
        opacity: valueAt(m.opacity, t) / 100,
        feather: valueAt(m.feather, t),
      })),
      matte: l.matte,
      isMatteSource: matteSources.has(l.id),
      active: l.visible && t >= l.inPoint && t < l.outPoint,
      content: resolveContent(l, t, assets, assetUrl, project, opts),
      effects: resolveEffects(l.effects, t),
    });
  }
  return { width: comp.width, height: comp.height, background: comp.background, time: t, layers };
}

/** Snap a time to the nearest frame boundary of the composition. */
export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}
export function frameCount(comp: Pick<Composition, "duration" | "fps">): number {
  return Math.round(comp.duration * comp.fps);
}
