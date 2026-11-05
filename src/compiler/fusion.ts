/**
 * Compiles a composition to a DaVinci Resolve / Fusion composition: a `.comp`
 * file (Fusion page: File › Import › Fusion Composition) and a `.setting`
 * file (the same nodes, to paste into any node view). Pure: no file access.
 * The node side (scripts/lib/node-export.ts exportFusion) copies assets and
 * renders the flattened layers listed in `groups`.
 *
 * Format (checked against Resolve 20.3's own templates and FuseExamples.comp,
 * and parsed by Resolve's fuscript bmd.readfile in tests/fusion.test.ts):
 *  - Lua tables: `Name = Tool { Inputs = { X = Input { Value = … } } }`.
 *  - Animated numbers link to a `BezierSpline` modifier; KeyFrames are keyed
 *    by FRAME, and LH/RH handles are absolute { frame, value } points.
 *  - Animated points (Center) link to an `XYPath` with one spline per axis.
 *  - Point inputs are normalised: (0,0) bottom-left, (1,1) top-right.
 *  - Mask sizes, polyline points and Text+ size are in units of the image
 *    WIDTH (FUSION_UNIT below), so a square stays square on a 16:9 frame.
 *
 * Mapping (per layer, top-level comp only):
 *  shape  rect/ellipse/static path -> RectangleMask/EllipseMask/PolylineMask
 *         chained (PaintMode) into a Background's EffectMask (the fill colour)
 *  solid  Background + RectangleMask
 *  text   TextPlus (font, style, size, colour, tracking, line spacing)
 *  image  Loader (PNG/JPG) merged at its place onto a transparent canvas
 *  null   no node of its own; its Transform is applied to its children
 *  then   one Transform per layer and per ancestor (parenting), with
 *         Pivot = anchor, Center = position, XSize/YSize = scale,
 *         Angle = -rotation (Fusion is counter-clockwise)
 *  then   a Merge per layer (bottom to top): Blend = opacity (0 outside the
 *         layer's in/out points), ApplyMode = blend mode
 * Easing: linear/bezier keyframes become spline handles (CSS cubic-bezier
 * x1,y1,x2,y2 is exactly a bezier with handles at those fractions); holds
 * get an extra key just before the next one. Expressions and curved motion
 * paths are sampled once per frame ("baked").
 *
 * Anything else (text animators and outlines, gradients, strokes, trim
 * paths, repeaters, offset paths, effects, masks, track mattes, nested
 * comps, video, SVG images, animated paths) is "flattened": consecutive
 * flattened layers are rendered by our own renderer to one PNG sequence
 * that a Loader brings in at the same place in the stack.
 */
import { parseColor } from "../core/color";
import { expressionHook } from "../core/evaluate";
import { setExpressionHook, valueAt } from "../core/interpolate";
import type { Asset, BlendMode, Composition, Ease, Keyframe, Layer, PathData, Project, Prop, ShapeLayer, Vec2 } from "../core/types";

/** Fusion measures mask sizes, polyline points and Text+ size in image widths. */
const FUSION_UNIT = "width" as const;

export interface FusionOptions {
  compId?: string;
  /** Output frame rate (default: the comp's). Keyframe times stay in seconds. */
  fps?: number;
  /** Output width (default: the comp's); height keeps the aspect ratio. */
  width?: number;
  /** Absolute folder the export is written to (Loader paths point into it). */
  outDir: string;
}

/** Layers rendered to one PNG sequence because Fusion nodes cannot represent them. */
export interface FlattenGroup {
  /** Folder relative to outDir, holding frame_00000.png … */
  dir: string;
  layerIds: string[];
  frames: number;
}

export interface FusionResult {
  comp: string;
  setting: string;
  /** Base name for the files (comp name, made safe). */
  fileName: string;
  groups: FlattenGroup[];
  /** Image assets to copy: asset id -> path relative to outDir. */
  assets: { asset: Asset; path: string }[];
  /** Human-readable list of what was flattened, baked or left out. */
  notes: string[];
  frames: number;
  width: number;
  height: number;
  fps: number;
}

// ---------------------------------------------------------------- Lua writer

type Lua = number | string | boolean | LuaTable;
interface LuaTable {
  ctor?: string;
  entries: [string | number | null, Lua][];
}
const tbl = (ctor: string | undefined, fields: Record<string, Lua | undefined> | [string | number | null, Lua][]): LuaTable => ({
  ctor,
  entries: Array.isArray(fields) ? fields : (Object.entries(fields).filter(([, v]) => v !== undefined) as [string, Lua][]),
});
const list = (...xs: Lua[]): LuaTable => tbl(undefined, xs.map((x) => [null, x] as [null, Lua]));
const fuid = (s: string) => tbl("FuID", [[null, s]]);

export function luaNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Number(n.toPrecision(12));
  return Object.is(r, -0) ? "0" : String(r);
}
export function luaString(s: string): string {
  return (
    '"' +
    s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => (c === "\\" ? "\\\\" : c === '"' ? '\\"' : c === "\n" ? "\\n" : c === "\t" ? "\\t" : "\\" + String(c.charCodeAt(0)).padStart(3, "0"))) +
    '"'
  );
}
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function luaKey(k: string | number): string {
  if (typeof k === "number") return `[${luaNumber(k)}]`;
  return IDENT.test(k) ? k : `[${luaString(k)}]`;
}
export function writeLua(v: Lua, indent = 0): string {
  if (typeof v === "number") return luaNumber(v);
  if (typeof v === "string") return luaString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  const head = v.ctor ? `${v.ctor} ` : "";
  if (!v.entries.length) return `${head}{ }`;
  // Short tables of scalars stay on one line ({ 0.5, 0.5 }, FuID { "Normal" }).
  if (v.entries.length <= 4 && v.entries.every(([, x]) => typeof x !== "object")) {
    return `${head}{ ${v.entries.map(([k, x]) => (k === null ? "" : `${luaKey(k)} = `) + writeLua(x)).join(", ")} }`;
  }
  const pad = "\t".repeat(indent + 1);
  const body = v.entries.map(([k, x]) => `${pad}${k === null ? "" : `${luaKey(k)} = `}${writeLua(x, indent + 1)},`).join("\n");
  return `${head}{\n${body}\n${"\t".repeat(indent)}}`;
}

// ------------------------------------------------------------ animation data

/** A key in Fusion units: frame, value, ease to the next key. */
interface FPoint {
  f: number;
  v: number;
  ease: Ease;
}
type Anim = { kind: "const"; v: number } | { kind: "pts"; pts: FPoint[] };
const LINEAR: Ease = { kind: "linear" };
const constant = (v: number): Anim => ({ kind: "const", v });

/** BezierSpline KeyFrames for a list of points (hold -> extra key just before the next key). */
function splineKeys(pts: FPoint[]): LuaTable {
  const xs: FPoint[] = [];
  pts.forEach((p, i) => {
    const next = pts[i + 1];
    if (next && p.ease.kind === "hold") {
      const eps = Math.min(0.001, (next.f - p.f) / 2);
      xs.push({ ...p, ease: LINEAR }, { f: next.f - eps, v: p.v, ease: LINEAR });
    } else xs.push(p);
  });
  const lh: (Vec2 | undefined)[] = [];
  const rh: (Vec2 | undefined)[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    const df = b.f - a.f;
    const dv = b.v - a.v;
    const e = a.ease;
    const [x1, y1, x2, y2] = e.kind === "bezier" ? [e.x1, e.y1, e.x2, e.y2] : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
    rh[i] = [a.f + x1 * df, a.v + y1 * dv];
    lh[i + 1] = [a.f + x2 * df, a.v + y2 * dv];
  }
  return tbl(
    undefined,
    xs.map((p, i) => {
      const linear = (i === 0 || xs[i - 1].ease.kind !== "bezier") && (i === xs.length - 1 || p.ease.kind !== "bezier");
      const fields: [string | number | null, Lua][] = [[null, p.v]];
      if (lh[i]) fields.push(["LH", list(lh[i]![0], lh[i]![1])]);
      if (rh[i]) fields.push(["RH", list(rh[i]![0], rh[i]![1])]);
      if (linear) fields.push(["Flags", tbl(undefined, { Linear: true })]);
      return [p.f, tbl(undefined, fields)] as [number, Lua];
    }),
  );
}

// ------------------------------------------------------------------ helpers

const BLEND: Record<BlendMode, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "Color Dodge",
  "color-burn": "Color Burn",
  "hard-light": "Hard Light",
  "soft-light": "Soft Light",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

const STYLE_BY_WEIGHT: [number, string][] = [
  [100, "Thin"],
  [200, "ExtraLight"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "SemiBold"],
  [700, "Bold"],
  [800, "ExtraBold"],
  [900, "Black"],
];
export function fontStyle(weight: number, italic: boolean): string {
  const w = STYLE_BY_WEIGHT.reduce((best, x) => (Math.abs(x[0] - weight) < Math.abs(best[0] - weight) ? x : best))[1];
  if (!italic) return w;
  return w === "Regular" ? "Italic" : `${w} Italic`;
}
/** First family of a CSS font list, without quotes. */
export function fontFamily(css: string): string {
  return (css.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "") || "Open Sans";
}

const hasSpatial = (p: Prop<Vec2>) => !!p.keyframes?.some((k) => (k.spatialIn && (k.spatialIn[0] || k.spatialIn[1])) || (k.spatialOut && (k.spatialOut[0] || k.spatialOut[1])));
const animated = (p: Prop | undefined) => !!p && (!!p.keyframes?.length || !!p.expression);

function safeIdent(s: string): string {
  let r = s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!r) r = "Layer";
  if (!/^[A-Za-z_]/.test(r)) r = "L_" + r;
  return r;
}

// ------------------------------------------------------------------ planner

/** Why a layer cannot become native Fusion nodes (empty = it can). */
export function flattenReasons(layer: Layer, project: Project): string[] {
  const r: string[] = [];
  if (layer.masks.length) r.push("masks");
  if (layer.matte) r.push("track matte");
  if (layer.effects?.some((e) => e.enabled)) r.push("effects");
  switch (layer.type) {
    case "precomp":
      r.push("nested composition");
      break;
    case "video":
      r.push("video layer");
      break;
    case "image": {
      const a = project.assets.find((x) => x.id === layer.assetId);
      if (!a) r.push("missing image");
      else if (a.src.startsWith("data:")) r.push("embedded image");
      else if (a.kind === "svg" || /\.svg$/i.test(a.src)) r.push("SVG image");
      break;
    }
    case "text":
      if (layer.animators.length) r.push("text animators");
      if (layer.style.stroke && (animated(layer.style.stroke.width) || layer.style.stroke.width.value > 0)) r.push("text outline");
      break;
    case "shape": {
      if (layer.fill.enabled && layer.fill.paint.kind !== "solid") r.push("gradient fill");
      if (layer.stroke.enabled) r.push("stroke");
      if (layer.trim.enabled) r.push("trim paths");
      if (layer.repeater?.enabled) r.push("repeater");
      if (layer.offsetPath?.enabled) r.push("offset path");
      if (layer.combine === "exclude" && layer.geometry.length > 1) r.push("exclude boolean");
      if (layer.geometry.some((g) => g.kind === "path" && animated(g.path))) r.push("animated path");
      break;
    }
  }
  return r;
}

type Plan =
  | { kind: "native"; layer: Layer }
  | { kind: "flat"; group: FlattenGroup; layers: Layer[] };

// ------------------------------------------------------------------ compiler

export function compileToFusion(project: Project, opts: FusionOptions): FusionResult {
  const comp: Composition = project.compositions.find((c) => c.id === (opts.compId ?? project.activeCompId)) ?? project.compositions[0];
  const fps = opts.fps ?? comp.fps;
  const W = comp.width;
  const H = comp.height;
  const outW = Math.round(opts.width ?? W);
  const outH = Math.round((outW / W) * H);
  const frames = Math.max(1, Math.round(comp.duration * fps));
  const last = frames - 1;
  const notes: string[] = [];
  const baked = new Set<string>();
  const fileName = safeIdent(comp.name) || "Composition";
  const outDir = opts.outDir.replace(/\/+$/, "");
  const prevHook = setExpressionHook(expressionHook(comp, project.brand));
  try {
    // --- which layers draw, and how
    const matteSources = new Set(comp.layers.filter((l) => l.matte).map((l) => l.matte!.layerId));
    const drawn = comp.layers.filter((l) => l.visible && !matteSources.has(l.id) && l.type !== "null" && l.type !== "reference" && l.type !== "audio");
    if (comp.layers.some((l) => l.type === "audio" && l.visible)) notes.push("Audio layers are not part of a Fusion comp; add the sound on Resolve's Edit page.");
    const plans: Plan[] = [];
    const groups: FlattenGroup[] = [];
    for (const l of drawn) {
      const why = flattenReasons(l, project);
      if (!why.length) {
        plans.push({ kind: "native", layer: l });
        continue;
      }
      notes.push(`${l.name} (${l.type}): rendered to PNG frames because of ${why.join(", ")}.`);
      if (l.blendMode !== "normal") notes.push(`${l.name}: its ${l.blendMode} blend mode is rendered against transparency, not the layers below.`);
      const prev = plans[plans.length - 1];
      if (prev?.kind === "flat") {
        prev.layers.push(l);
        prev.group.layerIds.push(l.id);
      } else {
        const group: FlattenGroup = { dir: `flattened/${String(groups.length + 1).padStart(2, "0")}-${safeIdent(l.name)}`, layerIds: [l.id], frames };
        groups.push(group);
        plans.push({ kind: "flat", group, layers: [l] });
      }
    }

    // --- tools
    const tools: [string, LuaTable][] = [];
    const used = new Set<string>();
    const name = (base: string) => {
      let n = safeIdent(base);
      if (used.has(n)) for (let i = 2; ; i++) if (!used.has(`${n}_${i}`)) { n = `${n}_${i}`; break; }
      used.add(n);
      return n;
    };
    const SPLINE_COLORS = [
      [255, 128, 0],
      [0, 200, 255],
      [255, 0, 128],
      [128, 255, 0],
    ];
    let splineCount = 0;
    const spline = (base: string, pts: FPoint[]): string => {
      const n = name(base);
      const [r, g, b] = SPLINE_COLORS[splineCount++ % SPLINE_COLORS.length];
      tools.push([n, tbl("BezierSpline", { SplineColor: tbl(undefined, { Red: r, Green: g, Blue: b }), NameSet: true, KeyFrames: splineKeys(pts) })]);
      return n;
    };
    const value = (v: Lua) => tbl("Input", { Value: v });
    const link = (op: string, source = "Output") => tbl("Input", { SourceOp: op, Source: source });
    /** Input for one scalar channel: a plain value or a link to a new spline. */
    const num = (tool: string, input: string, a: Anim): LuaTable => (a.kind === "const" ? value(a.v) : link(spline(tool + input, a.pts), "Value"));
    /** Input for a point: a plain value or an XYPath with a spline per animated axis. */
    const point = (tool: string, input: string, x: Anim, y: Anim): LuaTable => {
      if (x.kind === "const" && y.kind === "const") return value(list(x.v, y.v));
      const n = name(tool + input);
      tools.push([n, tbl("XYPath", { ShowKeyPoints: false, DrawMode: "ModifyOnly", Inputs: tbl(undefined, { X: num(n, "X", x), Y: num(n, "Y", y) }) })]);
      return link(n, "Value");
    };

    // --- turning properties into channels
    const sampleFrames = Array.from({ length: frames }, (_, f) => f);
    /** Channels of a property after an affine-per-component `map`; bakes expressions and curved motion paths. */
    function channels<T extends Vec2 | number | string>(p: Prop<T>, map: (v: T) => number[], label: string): Anim[] {
      const n = map(p.value).length;
      const bake = !!p.expression || (Array.isArray(p.value) && hasSpatial(p as unknown as Prop<Vec2>));
      if (bake) {
        baked.add(label);
        const vals = sampleFrames.map((f) => map(valueAt(p, f / fps)));
        return Array.from({ length: n }, (_, c) => collapse(sampleFrames.map((f, i) => ({ f, v: vals[i][c], ease: LINEAR }))));
      }
      if (!p.keyframes?.length) return map(p.value).map(constant);
      const ks = [...p.keyframes].sort((a, b) => a.t - b.t) as Keyframe<T>[];
      return Array.from({ length: n }, (_, c) => collapse(ks.map((k) => ({ f: k.t * fps, v: map(k.v)[c], ease: k.ease }))));
    }
    /** Samples of a function of time as a baked channel. */
    function sampled(fn: (t: number) => number, label: string): Anim {
      baked.add(label);
      return collapse(sampleFrames.map((f) => ({ f, v: fn(f / fps), ease: LINEAR })));
    }
    /** A channel whose keys all hold one value is a constant. */
    function collapse(pts: FPoint[]): Anim {
      if (pts.every((p) => Math.abs(p.v - pts[0].v) < 1e-9)) return constant(pts[0]?.v ?? 0);
      return { kind: "pts", pts };
    }
    /** Zero outside the layer's in/out points (frames fin..fout are visible). */
    function windowed(a: Anim, inPoint: number, outPoint: number, at: (t: number) => number): Anim {
      const fin = Math.max(0, Math.ceil(inPoint * fps - 1e-6));
      const fout = Math.min(last, Math.ceil(outPoint * fps - 1e-6) - 1);
      if (fout < fin) return constant(0);
      if (fin <= 0 && fout >= last) return a;
      const pts: FPoint[] = [];
      if (fin > 0) pts.push({ f: fin - 1, v: 0, ease: LINEAR });
      pts.push({ f: fin, v: at(fin / fps), ease: LINEAR });
      if (a.kind === "pts") {
        const inner = a.pts.filter((p) => p.f > fin && p.f < fout);
        // The boundary key eases linearly into the first kept key; kept keys keep their easing,
        // except the last one, whose segment is cut by the out point.
        inner.forEach((p, i) => pts.push(i === inner.length - 1 ? { ...p, ease: p.ease.kind === "hold" ? p.ease : LINEAR } : p));
      }
      if (fout > fin) pts.push({ f: fout, v: at(fout / fps), ease: LINEAR });
      if (fout < last) pts.push({ f: fout + 1, v: 0, ease: LINEAR });
      return { kind: "pts", pts };
    }

    // --- coordinate frames for parenting (see header): content of layer L is
    // drawn with layer-space point q at pixel q + offset(L).
    const byId = new Map(comp.layers.map((l) => [l.id, l]));
    const restTime = (l: Layer) => Math.min(comp.duration, Math.max(0, (Math.max(0, l.inPoint) + Math.min(comp.duration, l.outPoint)) / 2));
    const offsets = new Map<string, Vec2>();
    function offset(l: Layer | undefined, seen = new Set<string>()): Vec2 {
      if (!l) return [0, 0];
      const cached = offsets.get(l.id);
      if (cached) return cached;
      seen.add(l.id);
      const parent = l.parentId && !seen.has(l.parentId) ? byId.get(l.parentId) : undefined;
      const op = offset(parent, seen);
      const t = restTime(l);
      const p = valueAt(l.transform.position, t);
      const a = valueAt(l.transform.anchor, t);
      const o: Vec2 = [p[0] + op[0] - a[0], p[1] + op[1] - a[1]];
      offsets.set(l.id, o);
      return o;
    }
    const chain = (l: Layer): Layer[] => {
      const out: Layer[] = [l];
      const seen = new Set([l.id]);
      let p = l.parentId ? byId.get(l.parentId) : undefined;
      while (p && !seen.has(p.id)) {
        out.push(p);
        seen.add(p.id);
        p = p.parentId ? byId.get(p.parentId) : undefined;
      }
      return out;
    };
    const nx = (px: number) => px / W;
    const ny = (py: number) => 1 - py / H;
    /** Width-relative size (FUSION_UNIT). */
    const nw = (px: number) => (FUSION_UNIT === "width" ? px / W : px / H);

    /** Transform node for layer X applied to the image `input` (which is in X's frame). */
    function transformNode(owner: string, X: Layer, input: string, pos: Vec2): string {
      const tr = X.transform;
      const n = name(`${owner}_Transform${X.name === owner ? "" : "_" + X.name}`);
      const label = `${X.name}.transform`;
      const o = offset(X);
      const t0 = restTime(X);
      const P0 = valueAt(tr.position, t0);
      const A0 = valueAt(tr.anchor, t0);
      let center: Anim[];
      let pivot: LuaTable;
      if (animated(tr.anchor)) {
        // Pivot follows the anchor; Center compensates (see header).
        const cx = sampled((t) => 0.5 + (valueAt(tr.position, t)[0] - P0[0] - valueAt(tr.anchor, t)[0] + A0[0]) / W, `${label}.anchor`);
        const cy = sampled((t) => 0.5 - (valueAt(tr.position, t)[1] - P0[1] - valueAt(tr.anchor, t)[1] + A0[1]) / H, `${label}.anchor`);
        center = [cx, cy];
        pivot = point(n, "Pivot", sampled((t) => nx(valueAt(tr.anchor, t)[0] + o[0]), `${label}.anchor`), sampled((t) => ny(valueAt(tr.anchor, t)[1] + o[1]), `${label}.anchor`));
      } else {
        center = channels(tr.position, (v) => [0.5 + (v[0] - P0[0]) / W, 0.5 - (v[1] - P0[1]) / H], `${label}.position`);
        pivot = value(list(nx(A0[0] + o[0]), ny(A0[1] + o[1])));
      }
      const [sx, sy] = channels(tr.scale, (v) => [v[0] / 100, v[1] / 100], `${label}.scale`);
      const [angle] = channels(tr.rotation, (v) => [-v], `${label}.rotation`);
      tools.push([
        n,
        tbl("Transform", {
          Inputs: tbl(undefined, {
            Center: point(n, "Center", center[0], center[1]),
            Pivot: pivot,
            UseSizeAndAspect: value(0),
            XSize: num(n, "XSize", sx),
            YSize: num(n, "YSize", sy),
            Angle: num(n, "Angle", angle),
            Input: link(input),
          }),
          ViewInfo: tbl("OperatorInfo", { Pos: list(pos[0], pos[1]) }),
        }),
      ]);
      return n;
    }

    const genSize = { Width: value(outW), Height: value(outH), UseFrameFormatSettings: value(0), GlobalOut: value(last) };
    const maskSize = { MaskWidth: value(outW), MaskHeight: value(outH), PixelAspect: value(list(1, 1)), UseFrameFormatSettings: value(0), ClippingMode: value(fuid("None")) };
    const colorInputs = (tool: string, p: Prop<string>, label: string, keys: [string, string, string, string]) => {
      const ch = channels(p, (c) => {
        const x = parseColor(c);
        return [x.r / 255, x.g / 255, x.b / 255, x.a];
      }, label);
      return Object.fromEntries(keys.map((k, i) => [k, num(tool, k, ch[i])]));
    };

    // Transparent (or coloured) canvas everything merges onto.
    const canvas = name("Canvas");
    const bg = comp.background ? parseColor(comp.background) : null;
    tools.push([
      canvas,
      tbl("Background", {
        Inputs: tbl(undefined, {
          ...genSize,
          TopLeftRed: value(bg ? bg.r / 255 : 0),
          TopLeftGreen: value(bg ? bg.g / 255 : 0),
          TopLeftBlue: value(bg ? bg.b / 255 : 0),
          TopLeftAlpha: value(bg ? bg.a : 0),
        }),
        ViewInfo: tbl("OperatorInfo", { Pos: list(-110, 0) }),
      }),
    ]);

    /** Content node of a native layer in its own frame; returns the tool name. */
    function content(l: Layer, x: number): string | null {
      const o = offset(l);
      const label = l.name;
      let y = -33 * 12;
      const pos = (): Vec2 => [x, (y += 33)];
      if (l.type === "shape" || l.type === "solid") {
        let maskOut: string | null = null;
        const geoms: { kind: "rect" | "ellipse" | "path"; g: ShapeLayer["geometry"][number] | null }[] =
          l.type === "solid" ? [{ kind: "rect", g: null }] : l.geometry.map((g) => ({ kind: g.kind, g }));
        if (l.type === "shape" && !l.fill.enabled) return null; // nothing to draw (strokes are flattened)
        geoms.forEach(({ kind, g }, i) => {
          const tool = name(`${l.name}_${kind === "rect" ? "Rectangle" : kind === "ellipse" ? "Ellipse" : "Polygon"}`);
          const mode = i === 0 ? null : l.type === "shape" && l.combine === "subtract" ? "Subtract" : l.type === "shape" && l.combine === "intersect" ? "Minimum" : "Maximum";
          const inputs: Record<string, Lua | undefined> = { ...maskSize };
          if (mode) inputs.PaintMode = value(fuid(mode));
          if (l.type === "solid") {
            inputs.Center = value(list(nx(l.width / 2 + o[0]), ny(l.height / 2 + o[1])));
            inputs.Width = value(nw(l.width));
            inputs.Height = value(nw(l.height));
          } else if (g && (g.kind === "rect" || g.kind === "ellipse")) {
            const [cx, cy] = channels(g.position, (v) => [nx(v[0] + o[0]), ny(v[1] + o[1])], `${label}.geometry.position`);
            const [w, h] = channels(g.size, (v) => [nw(Math.abs(v[0])), nw(Math.abs(v[1]))], `${label}.geometry.size`);
            inputs.Center = point(tool, "Center", cx, cy);
            inputs.Width = num(tool, "Width", w);
            inputs.Height = num(tool, "Height", h);
            if (g.kind === "rect") {
              const s = valueAt(g.size, restTime(l));
              const half = Math.min(Math.abs(s[0]), Math.abs(s[1])) / 2;
              const [cr] = channels(g.roundness, (r) => [half > 0 ? Math.min(1, Math.max(0, r) / half) : 0], `${label}.geometry.roundness`);
              inputs.CornerRadius = num(tool, "CornerRadius", cr);
            }
          } else if (g && g.kind === "path") {
            inputs.Center = value(list(nx(o[0]), ny(o[1])));
            inputs.Polyline = value(polyline(g.path.value));
          }
          if (maskOut) inputs.EffectMask = link(maskOut, "Mask");
          const ctor = kind === "rect" ? "RectangleMask" : kind === "ellipse" ? "EllipseMask" : "PolylineMask";
          tools.push([tool, tbl(ctor, { ...(kind === "path" ? { DrawMode: "ModifyOnly", DrawMode2: "InsertAndModify" } : {}), Inputs: tbl(undefined, inputs), ViewInfo: tbl("OperatorInfo", { Pos: list(...pos()) }) })]);
          maskOut = tool;
        });
        const fill = name(`${l.name}_Fill`);
        const colorProp = l.type === "solid" ? l.color : (l.fill.paint as { color: Prop<string> }).color;
        tools.push([
          fill,
          tbl("Background", {
            Inputs: tbl(undefined, {
              ...genSize,
              ...colorInputs(fill, colorProp, `${label}.color`, ["TopLeftRed", "TopLeftGreen", "TopLeftBlue", "TopLeftAlpha"]),
              EffectMask: maskOut ? link(maskOut, "Mask") : undefined,
            }),
            ViewInfo: tbl("OperatorInfo", { Pos: list(...pos()) }),
          }),
        ]);
        return fill;
      }
      if (l.type === "text") {
        const tool = name(`${l.name}_Text`);
        const st = l.style;
        const t0 = restTime(l);
        const size0 = valueAt(st.size, t0);
        const lines = l.text.split("\n").length;
        // Our text sits on its baseline; a glyph's middle is 0.35 em above it. Text+ centres the block.
        const midY = ((lines - 1) * st.lineHeight * size0) / 2 - 0.35 * size0;
        const [size] = channels(st.size, (v) => [nw(v)], `${label}.style.size`);
        const [tracking] = channels(st.tracking, (v) => [1 + v / Math.max(1, 0.55 * size0)], `${label}.style.tracking`);
        tools.push([
          tool,
          tbl("TextPlus", {
            Inputs: tbl(undefined, {
              ...genSize,
              StyledText: value(l.text),
              Font: value(fontFamily(st.family)),
              Style: value(fontStyle(st.weight, st.italic)),
              Size: num(tool, "Size", size),
              CharacterSpacing: num(tool, "CharacterSpacing", tracking),
              LineSpacing: value(st.lineHeight / 1.2),
              Center: value(list(nx(o[0]), ny(o[1] + midY))),
              HorizontalLeftCenterRight: value(st.align === "left" ? -1 : st.align === "right" ? 1 : 0),
              HorizontalJustificationNew: value(3),
              VerticalJustificationNew: value(3),
              ...colorInputs(tool, st.fill, `${label}.style.fill`, ["Red1", "Green1", "Blue1", "Alpha1"]),
            }),
            ViewInfo: tbl("OperatorInfo", { Pos: list(...pos()) }),
          }),
        ]);
        return tool;
      }
      if (l.type === "image") {
        const a = project.assets.find((z) => z.id === l.assetId)!;
        const rel = assetPath(a);
        const loader = name(`${l.name}_Loader`);
        tools.push([loader, loaderTool(`${outDir}/${rel}`, /\.png$/i.test(a.src) ? "PNGFormat" : "JpegFormat", 1, false, pos())]);
        const merge = name(`${l.name}_Place`);
        tools.push([
          merge,
          tbl("Merge", {
            Inputs: tbl(undefined, {
              Background: link(canvas),
              Foreground: link(loader),
              Center: value(list(nx(a.width / 2 + o[0]), ny(a.height / 2 + o[1]))),
              Size: value(outW / W),
              PerformDepthMerge: value(0),
            }),
            ViewInfo: tbl("OperatorInfo", { Pos: list(...pos()) }),
          }),
        ]);
        return merge;
      }
      return null;
    }

    const assets: { asset: Asset; path: string }[] = [];
    function assetPath(a: Asset): string {
      const found = assets.find((x) => x.asset.id === a.id);
      if (found) return found.path;
      const base = (a.src.split("/").pop() ?? a.id).replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `assets/${a.id}-${base}`;
      assets.push({ asset: a, path });
      return path;
    }
    function loaderTool(file: string, format: string, length: number, sequence: boolean, pos: Vec2): LuaTable {
      return tbl("Loader", {
        Clips: list(
          tbl("Clip", {
            ID: "Clip1",
            Filename: file,
            FormatID: format,
            StartFrame: sequence ? 0 : -1,
            Length: length,
            LengthSetManually: true,
            TrimIn: 0,
            TrimOut: length - 1,
            ExtendFirst: 0,
            ExtendLast: 0,
            Loop: 0,
            AspectMode: 0,
            Depth: 0,
            TimeCode: 0,
            GlobalStart: 0,
            GlobalEnd: sequence ? length - 1 : last,
          }),
        ),
        Inputs: tbl(undefined, { PostMultiplyByAlpha: format === "PNGFormat" ? value(1) : undefined, ["Gamut.SLogVersion"]: value(fuid("SLog2")) }),
        ViewInfo: tbl("OperatorInfo", { Pos: list(pos[0], pos[1]) }),
      });
    }
    function polyline(path: PathData): LuaTable {
      const pts = path.points.map((pt) =>
        tbl(undefined, {
          X: nw(pt.p[0]),
          Y: -nw(pt.p[1]),
          LX: nw(pt.in[0]),
          LY: -nw(pt.in[1]),
          RX: nw(pt.out[0]),
          RY: -nw(pt.out[1]),
        }),
      );
      return tbl("Polyline", { Closed: path.closed, Points: list(...pts) });
    }

    // --- build each layer, bottom to top, merging onto the canvas
    let below = canvas;
    let col = 0;
    for (let i = plans.length - 1; i >= 0; i--, col++) {
      const pl = plans[i];
      const x = col * 165;
      let out: string | null;
      let blend: Anim;
      let mode = "Normal";
      let label: string;
      if (pl.kind === "flat") {
        label = pl.layers.length === 1 ? pl.layers[0].name : `${pl.layers[pl.layers.length - 1].name} to ${pl.layers[0].name}`;
        out = name(`Flattened_${pl.layers[0].name}`);
        tools.push([out, loaderTool(`${outDir}/${pl.group.dir}/frame_00000.png`, "PNGFormat", frames, true, [x, -66])]);
        blend = constant(1);
      } else {
        const l = pl.layer;
        label = l.name;
        out = content(l, x);
        if (!out) continue;
        const xs = chain(l);
        xs.forEach((X, k) => (out = transformNode(l.name, X, out!, [x, -33 * (xs.length - k)])));
        const k = l.type === "shape" ? l.fill.opacity : null;
        const op = l.transform.opacity;
        const at = (t: number) => (Math.max(0, Math.min(100, valueAt(op, t))) / 100) * (k ? Math.max(0, Math.min(100, valueAt(k, t))) / 100 : 1);
        let base: Anim;
        if (!op.expression && !(k && animated(k))) {
          const kk = k ? valueAt(k, 0) / 100 : 1;
          base = channels(op, (v) => [(Math.max(0, Math.min(100, v)) / 100) * kk], `${label}.opacity`)[0];
        } else base = sampled(at, `${label}.opacity`);
        blend = windowed(base, l.inPoint, l.outPoint, at);
        mode = BLEND[l.blendMode] ?? "Normal";
      }
      const merge = name(`${label}_Merge`);
      tools.push([
        merge,
        tbl("Merge", {
          Inputs: tbl(undefined, {
            Blend: num(merge, "Blend", blend),
            Background: link(below),
            Foreground: link(out),
            ApplyMode: mode === "Normal" ? undefined : value(fuid(mode)),
            PerformDepthMerge: value(0),
          }),
          ViewInfo: tbl("OperatorInfo", { Pos: list(x, 49.5) }),
        }),
      ]);
      below = merge;
    }
    if (baked.size) notes.push(`Sampled once per frame (expressions, curved motion paths or animated anchors): ${[...baked].join(", ")}.`);
    notes.push(`Text+ uses the first font of each layer's font list; install it on this Mac if Resolve shows a different font.`);

    const nodes = tbl("ordered()", tools.map(([n, t]) => [n, t] as [string, Lua]));
    const mediaOut = tbl("MediaOut", {
      Inputs: tbl(undefined, { Index: value("0"), Input: link(below) }),
      ViewInfo: tbl("OperatorInfo", { Pos: list(col * 165 + 55, 49.5) }),
    });
    const compTools = tbl("ordered()", [...nodes.entries, ["MediaOut1", mediaOut]]);
    const compTable = tbl("Composition", {
      CurrentTime: 0,
      RenderRange: list(0, last),
      GlobalRange: list(0, last),
      CurrentID: tools.length + 1,
      HiQ: true,
      PlaybackUpdateMode: 0,
      StereoMode: false,
      SavedOutputs: 0,
      HeldTools: 0,
      DisabledTools: 0,
      LockedTools: 0,
      AudioOffset: 0,
      Resumable: true,
      OutputClips: tbl(undefined, []),
      Tools: compTools,
      Prefs: tbl(undefined, {
        Comp: tbl(undefined, {
          FrameFormat: tbl(undefined, { Width: outW, Height: outH, Rate: fps, AspectX: 1, AspectY: 1, GuideRatio: outW / outH }),
          Unsorted: tbl(undefined, { GlobalEnd: last }),
        }),
      }),
    });
    const comp_ = writeLua(compTable) + "\n";
    const setting = writeLua(tbl(undefined, { Tools: nodes, ActiveTool: below })) + "\n";
    return { comp: comp_, setting, fileName, groups, assets, notes, frames, width: outW, height: outH, fps };
  } finally {
    setExpressionHook(prevHook);
  }
}
