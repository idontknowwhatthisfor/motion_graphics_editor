import type { PathData, Vec2 } from "./types";

/** 2D affine matrix [a, b, c, d, e, f] as in SVG/CSS `matrix()`. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [...IDENTITY];
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

export function apply(m: Mat, p: Vec2): Vec2 {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** Local matrix: translate(position) · rotate · scale · translate(-anchor). */
export function layerMatrix(anchor: Vec2, position: Vec2, scalePct: Vec2, rotationDeg: number): Mat {
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = scalePct[0] / 100;
  const sy = scalePct[1] / 100;
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  return [a, b, c, d, position[0] - (a * anchor[0] + c * anchor[1]), position[1] - (b * anchor[0] + d * anchor[1])];
}

const f = (n: number) => (Math.abs(n) < 1e-9 ? "0" : String(Math.round(n * 1000) / 1000));

export function pathToD(path: PathData): string {
  const pts = path.points;
  if (pts.length === 0) return "";
  let d = `M${f(pts[0].p[0])} ${f(pts[0].p[1])}`;
  const seg = (a: (typeof pts)[number], b: (typeof pts)[number]) => {
    const c1: Vec2 = [a.p[0] + a.out[0], a.p[1] + a.out[1]];
    const c2: Vec2 = [b.p[0] + b.in[0], b.p[1] + b.in[1]];
    const straight = a.out[0] === 0 && a.out[1] === 0 && b.in[0] === 0 && b.in[1] === 0;
    return straight
      ? `L${f(b.p[0])} ${f(b.p[1])}`
      : `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(b.p[0])} ${f(b.p[1])}`;
  };
  for (let i = 1; i < pts.length; i++) d += seg(pts[i - 1], pts[i]);
  if (path.closed && pts.length > 1) d += seg(pts[pts.length - 1], pts[0]) + "Z";
  return d;
}

/** Rectangle centred on `pos` with corner radius `r`. */
export function rectToD(pos: Vec2, size: Vec2, r: number): string {
  const w = Math.abs(size[0]);
  const h = Math.abs(size[1]);
  const x = pos[0] - w / 2;
  const y = pos[1] - h / 2;
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  return (
    `M${f(x + rr)} ${f(y)}H${f(x + w - rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w)} ${f(y + rr)}` +
    `V${f(y + h - rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w - rr)} ${f(y + h)}` +
    `H${f(x + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x)} ${f(y + h - rr)}` +
    `V${f(y + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + rr)} ${f(y)}Z`
  );
}

export function ellipseToD(pos: Vec2, size: Vec2): string {
  const rx = Math.abs(size[0]) / 2;
  const ry = Math.abs(size[1]) / 2;
  const [cx, cy] = pos;
  return (
    `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}` +
    `A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`
  );
}

/** A closed rectangular PathData, e.g. for a default mask or the pen tool. */
export function rectPath(x: number, y: number, w: number, h: number): PathData {
  const z: Vec2 = [0, 0];
  return {
    closed: true,
    points: [
      { p: [x, y], in: z, out: z },
      { p: [x + w, y], in: z, out: z },
      { p: [x + w, y + h], in: z, out: z },
      { p: [x, y + h], in: z, out: z },
    ],
  };
}

/**
 * Trim paths as an SVG dash pattern on a path with pathLength=100.
 * start/end are percentages, offset in degrees (one turn = whole path).
 */
export function trimDash(start: number, end: number, offsetDeg: number): { dasharray: string; dashoffset: number } | null {
  let s = Math.min(start, end);
  let e = Math.max(start, end);
  s = Math.max(0, Math.min(100, s));
  e = Math.max(0, Math.min(100, e));
  if (s <= 0 && e >= 100) return null; // untrimmed
  const len = e - s;
  if (len <= 0) return { dasharray: "0 100", dashoffset: 0 };
  const o = (((offsetDeg / 360) * 100) % 100 + 100) % 100;
  s += o;
  e += o;
  if (e <= 100) return { dasharray: `0 ${f(s)} ${f(len)} ${f(100 - e + 0.0001)}`, dashoffset: 0 };
  if (s >= 100) return { dasharray: `0 ${f(s - 100)} ${f(len)} 100`, dashoffset: 0 };
  const a = e - 100;
  return { dasharray: `${f(a)} ${f(s - a)} ${f(100 - s)} 0`, dashoffset: 0 };
}
