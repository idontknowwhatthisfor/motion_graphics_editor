/**
 * The one renderer: draws a ResolvedScene as SVG. The editor preview, the
 * `render_frame` checks and the compiled HyperFrames export all run this same
 * code in Chromium, so preview pixels match export pixels.
 */
import type { CharState, ResolvedLayer, ResolvedMask, ResolvedPaint, ResolvedScene } from "../core/evaluate";
import type { Mat } from "../core/geometry";
import { h, patchChildren, SVG_NS, type VNode } from "./vdom";

const BIG = 100000;
const BIG_RECT = `M${-BIG} ${-BIG}H${BIG}V${BIG}H${-BIG}Z`;

const num = (n: number) => (Math.abs(n) < 1e-9 ? 0 : Math.round(n * 10000) / 10000);
const matrix = (m: Mat) => `matrix(${m.map(num).join(" ")})`;
const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

export type MeasureText = (text: string, font: string) => number;

let sharedCtx: CanvasRenderingContext2D | null = null;
export const canvasMeasure: MeasureText = (text, font) => {
  if (!sharedCtx) sharedCtx = document.createElement("canvas").getContext("2d");
  if (!sharedCtx) return text.length * 10;
  sharedCtx.font = font;
  return sharedCtx.measureText(text).width;
};

interface Ctx {
  defs: VNode[];
  measure: MeasureText;
  scene: ResolvedScene;
}

function paintRef(ctx: Ctx, paint: ResolvedPaint, key: string): string {
  if (paint.kind === "solid") return paint.color;
  const id = `g_${key}`;
  const stops = paint.stops.map((s, i) => h("stop", String(i), { offset: num(s.offset), "stop-color": s.color }));
  if (paint.kind === "linear") {
    ctx.defs.push(
      h("linearGradient", id, { id, gradientUnits: "userSpaceOnUse", x1: num(paint.start[0]), y1: num(paint.start[1]), x2: num(paint.end[0]), y2: num(paint.end[1]) }, stops),
    );
  } else {
    const r = Math.hypot(paint.end[0] - paint.start[0], paint.end[1] - paint.start[1]);
    ctx.defs.push(h("radialGradient", id, { id, gradientUnits: "userSpaceOnUse", cx: num(paint.start[0]), cy: num(paint.start[1]), r: num(r) }, stops));
  }
  return `url(#${id})`;
}

function blurFilter(ctx: Ctx, amount: number): string {
  const id = `blur_${Math.round(amount * 10)}`;
  if (!ctx.defs.some((d) => d.key === id))
    ctx.defs.push(
      h("filter", id, { id, x: "-50%", y: "-50%", width: "200%", height: "200%" }, [
        h("feGaussianBlur", "b", { stdDeviation: num(amount / 2) }),
      ]),
    );
  return `url(#${id})`;
}

function fontString(c: { italic: boolean; weight: number; size: number; family: string }) {
  return `${c.italic ? "italic " : ""}${c.weight} ${c.size}px ${c.family}`;
}

function textContent(ctx: Ctx, L: ResolvedLayer): VNode[] {
  const c = L.content;
  if (c.type !== "text") return [];
  const lines = c.text.split("\n");
  const lh = c.size * c.lineHeight;
  const anchor = c.align === "left" ? "start" : c.align === "right" ? "end" : "middle";
  const common = {
    "font-family": c.family,
    "font-size": num(c.size),
    "font-weight": c.weight,
    "font-style": c.italic ? "italic" : "normal",
    fill: c.fill,
    stroke: c.stroke && c.stroke.width > 0 ? c.stroke.color : undefined,
    "stroke-width": c.stroke && c.stroke.width > 0 ? num(c.stroke.width) : undefined,
    "paint-order": "stroke",
    "xml:space": "preserve",
    style: "white-space:pre",
  };
  if (!c.chars) {
    return [
      h(
        "text",
        "t",
        { ...common, "text-anchor": anchor, "letter-spacing": c.tracking ? num(c.tracking) : undefined },
        lines.map((ln, i) => h("tspan", String(i), { x: 0, y: num(i * lh) }, ln || " ")),
      ),
    ];
  }
  // Per-character layout for text animators (ED-10).
  const font = fontString(c);
  const out: VNode[] = [];
  let ci = 0;
  lines.forEach((line, li) => {
    const lc = Array.from(line);
    const adv: number[] = [];
    let prefix = "";
    let prevW = 0;
    for (const ch of lc) {
      prefix += ch;
      const w = ctx.measure(prefix, font);
      adv.push(w - prevW + c.tracking);
      prevW = w;
    }
    const total = adv.reduce((a, b) => a + b, 0) - (lc.length ? c.tracking : 0);
    let x = c.align === "left" ? 0 : c.align === "right" ? -total : -total / 2;
    lc.forEach((ch, k) => {
      const st: CharState = c.chars![ci + k];
      const w = adv[k] - c.tracking;
      if (!/\s/.test(ch) && st && st.opacity > 0.0005) {
        const cx = x + w / 2;
        const cy = li * lh - c.size * 0.35;
        const tr =
          `translate(${num(cx + st.dx)} ${num(cy + st.dy)})` +
          (st.rot ? ` rotate(${num(st.rot)})` : "") +
          (st.sx !== 1 || st.sy !== 1 ? ` scale(${num(st.sx)} ${num(st.sy)})` : "") +
          ` translate(${num(-w / 2)} ${num(c.size * 0.35)})`;
        out.push(
          h(
            "text",
            `c${ci + k}`,
            {
              ...common,
              fill: st.fill,
              transform: tr,
              opacity: st.opacity < 0.9995 ? num(st.opacity) : undefined,
              filter: st.blur > 0.05 ? blurFilter(ctx, st.blur) : undefined,
            },
            ch,
          ),
        );
      }
      x += adv[k];
    });
    ci += lc.length + 1; // +1 for the newline
  });
  return out;
}

function shapeContent(ctx: Ctx, L: ResolvedLayer): VNode[] {
  const c = L.content;
  if (c.type !== "shape" || c.paths.length === 0) return [];
  const key = safe(L.id);
  const out: VNode[] = [];
  const allD = c.paths.join("");
  let fillD = allD;
  let fillRule: string = "nonzero";
  let fillMask: string | undefined;
  if (c.combine === "exclude") fillRule = "evenodd";
  if ((c.combine === "subtract" || c.combine === "intersect") && c.paths.length > 1) {
    fillD = c.paths[0];
    const mid = `bool_${key}`;
    const rest = c.paths.slice(1);
    const kids = [h("path", "bg", { d: BIG_RECT, fill: "#fff" }), ...rest.map((d, i) => h("path", String(i), { d, fill: "#000" }))];
    if (c.combine === "intersect") {
      // Build an intersection by successive masks.
      let maskId = "";
      rest.forEach((d, i) => {
        const id = `${mid}_${i}`;
        ctx.defs.push(
          h("mask", id, { id, maskUnits: "userSpaceOnUse", x: -BIG, y: -BIG, width: 2 * BIG, height: 2 * BIG }, [
            maskId ? h("g", "g", { mask: `url(#${maskId})` }, [h("path", "p", { d, fill: "#fff" })]) : h("path", "p", { d, fill: "#fff" }),
          ]),
        );
        maskId = id;
      });
      fillMask = `url(#${maskId})`;
    } else {
      ctx.defs.push(h("mask", mid, { id: mid, maskUnits: "userSpaceOnUse", x: -BIG, y: -BIG, width: 2 * BIG, height: 2 * BIG }, kids));
      fillMask = `url(#${mid})`;
    }
  }
  if (c.fill && c.fill.opacity > 0) {
    out.push(
      h("path", "fill", {
        d: fillD,
        fill: paintRef(ctx, c.fill.paint, `${key}_f`),
        "fill-rule": fillRule,
        "fill-opacity": c.fill.opacity < 1 ? num(c.fill.opacity) : undefined,
        mask: fillMask,
      }),
    );
  }
  if (c.stroke && c.stroke.width > 0 && c.stroke.opacity > 0) {
    const tr = c.stroke.trim;
    out.push(
      h("path", "stroke", {
        d: allD,
        fill: "none",
        stroke: paintRef(ctx, c.stroke.paint, `${key}_s`),
        "stroke-width": num(c.stroke.width),
        "stroke-opacity": c.stroke.opacity < 1 ? num(c.stroke.opacity) : undefined,
        "stroke-linecap": c.stroke.lineCap,
        "stroke-linejoin": c.stroke.lineJoin,
        pathLength: tr ? 100 : undefined,
        "stroke-dasharray": tr ? tr.dasharray : undefined,
        "stroke-dashoffset": tr ? tr.dashoffset : undefined,
      }),
    );
  }
  return out;
}

function layerContent(ctx: Ctx, L: ResolvedLayer): VNode[] {
  const c = L.content;
  switch (c.type) {
    case "solid":
      return [h("rect", "r", { x: 0, y: 0, width: c.width, height: c.height, fill: c.color })];
    case "image":
      return c.src ? [h("image", "i", { href: c.src, x: 0, y: 0, width: c.width, height: c.height, preserveAspectRatio: "none" })] : [];
    case "reference":
      return c.src
        ? [
            h("foreignObject", "fo", { x: 0, y: 0, width: c.width, height: c.height }, [
              h("video", "v", { src: c.src, muted: "", playsinline: "", preload: "auto", "data-time": num(c.mediaTime), style: `width:${c.width}px;height:${c.height}px;display:block` }),
            ]),
          ]
        : [];
    case "shape":
      return shapeContent(ctx, L);
    case "text":
      return textContent(ctx, L);
    case "null":
      return [];
  }
}

/** Layer masks (ED-04): composed in layer space. Returns a mask url or undefined. */
function layerMask(ctx: Ctx, L: ResolvedLayer): string | undefined {
  if (L.masks.length === 0) return undefined;
  const id = `lm_${safe(L.id)}`;
  const shape = (m: ResolvedMask, color: string, k: string): VNode =>
    h("path", k, {
      d: m.inverted ? BIG_RECT + m.d : m.d,
      "fill-rule": m.inverted ? "evenodd" : "nonzero",
      fill: color,
      "fill-opacity": m.opacity < 1 ? num(m.opacity) : undefined,
      filter: m.feather > 0.05 ? blurFilter(ctx, m.feather) : undefined,
    });
  let kids: VNode[] = [];
  if (L.masks[0].mode !== "add") kids.push(h("path", "base", { d: BIG_RECT, fill: "#fff" }));
  L.masks.forEach((m, i) => {
    if (m.mode === "add") kids.push(shape(m, "#fff", `m${i}`));
    else if (m.mode === "subtract") kids.push(shape(m, "#000", `m${i}`));
    else {
      const sub = `${id}_i${i}`;
      ctx.defs.push(h("mask", sub, { id: sub, maskUnits: "userSpaceOnUse", x: -BIG, y: -BIG, width: 2 * BIG, height: 2 * BIG }, [shape(m, "#fff", "p")]));
      kids = [h("g", `ig${i}`, { mask: `url(#${sub})` }, kids)];
    }
  });
  ctx.defs.push(h("mask", id, { id, maskUnits: "userSpaceOnUse", x: -BIG, y: -BIG, width: 2 * BIG, height: 2 * BIG }, kids));
  return `url(#${id})`;
}

function layerNode(ctx: Ctx, L: ResolvedLayer, keyPrefix = ""): VNode {
  const inner = h("g", "content", { transform: matrix(L.matrix), mask: layerMask(ctx, L), "data-content": L.id }, layerContent(ctx, L));
  return h(
    "g",
    keyPrefix + L.id,
    {
      "data-layer": keyPrefix ? undefined : L.id,
      opacity: L.opacity < 1 ? num(L.opacity) : undefined,
      style: L.blendMode !== "normal" ? `mix-blend-mode:${L.blendMode}` : undefined,
    },
    [inner],
  );
}

/** Track matte (ED-04): mask built from another layer's rendering. */
function matteMask(ctx: Ctx, L: ResolvedLayer, src: ResolvedLayer | undefined): string {
  const id = `mt_${safe(L.id)}`;
  const mode = L.matte!.mode;
  const content = src && src.active ? [layerNode(ctx, src, "matte_")] : [];
  let kids: VNode[] = content;
  let style = "mask-type:luminance";
  if (mode === "alpha") style = "mask-type:alpha";
  else if (mode === "lumaInverted" || mode === "alphaInverted") {
    const fid = `${id}_inv`;
    // alphaInverted: draw white everywhere, then the matte in black (keeps its alpha).
    // lumaInverted: invert the matte's RGB, transparent areas count as black->white.
    const matrixValues = mode === "alphaInverted" ? "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" : "-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0";
    ctx.defs.push(h("filter", fid, { id: fid, x: -BIG, y: -BIG, width: 2 * BIG, height: 2 * BIG, filterUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" }, [h("feColorMatrix", "m", { type: "matrix", values: matrixValues })]));
    kids = [h("path", "bg", { d: BIG_RECT, fill: "#fff" }), h("g", "inv", { filter: `url(#${fid})` }, content)];
  }
  ctx.defs.push(h("mask", id, { id, maskUnits: "userSpaceOnUse", x: -BIG, y: -BIG, width: 2 * BIG, height: 2 * BIG, style }, kids));
  return `url(#${id})`;
}

export function sceneToVNodes(scene: ResolvedScene, measure: MeasureText): { defs: VNode[]; body: VNode[] } {
  const ctx: Ctx = { defs: [], measure, scene };
  const byId = new Map(scene.layers.map((l) => [l.id, l]));
  const body: VNode[] = [];
  if (scene.background) body.push(h("rect", "__bg", { x: 0, y: 0, width: scene.width, height: scene.height, fill: scene.background }));
  for (const L of scene.layers) {
    if (!L.active || L.isMatteSource || L.content.type === "null") continue;
    const node = layerNode(ctx, L);
    if (L.matte) node.attrs.mask = matteMask(ctx, L, byId.get(L.matte.layerId));
    body.push(node);
  }
  return { defs: ctx.defs, body };
}

/**
 * Renders scenes into an <svg> element. Construct once, call render() per
 * frame. Works in any Chromium page (editor, Playwright, HyperFrames).
 */
export class SvgRenderer {
  readonly svg: SVGSVGElement;
  private defs: SVGDefsElement;
  private body: SVGGElement;
  constructor(
    container: Element,
    private measure: MeasureText = canvasMeasure,
  ) {
    const doc = container.ownerDocument;
    this.svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    this.svg.setAttribute("xmlns", SVG_NS);
    this.svg.style.display = "block";
    this.svg.style.overflow = "hidden";
    this.svg.style.isolation = "isolate";
    this.defs = doc.createElementNS(SVG_NS, "defs") as SVGDefsElement;
    this.body = doc.createElementNS(SVG_NS, "g") as SVGGElement;
    this.svg.append(this.defs, this.body);
    container.appendChild(this.svg);
  }

  render(scene: ResolvedScene) {
    const { width, height } = scene;
    if (this.svg.getAttribute("viewBox") !== `0 0 ${width} ${height}`) {
      this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      this.svg.setAttribute("width", String(width));
      this.svg.setAttribute("height", String(height));
    }
    const { defs, body } = sceneToVNodes(scene, this.measure);
    patchChildren(this.defs, defs);
    patchChildren(this.body, body);
    // Reference video: seek to the right media time.
    this.svg.querySelectorAll("video").forEach((v) => {
      const t = Number(v.getAttribute("data-time"));
      if (Number.isFinite(t) && Math.abs(v.currentTime - t) > 0.04) v.currentTime = t;
    });
  }

  /** Local-space bounding box of a layer's content (for selection handles). */
  layerBBox(layerId: string): DOMRect | null {
    const el = this.body.querySelector(`[data-content="${CSS.escape(layerId)}"]`) as SVGGraphicsElement | null;
    if (!el) return null;
    try {
      const b = el.getBBox();
      return b.width || b.height ? b : null;
    } catch {
      return null;
    }
  }

  destroy() {
    this.svg.remove();
  }
}
