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

/** Matrix of a repeater-style transform applied `k` times (k may be fractional). */
export function repeatMatrix(anchor: Vec2, position: Vec2, scalePct: Vec2, rotationDeg: number, k: number): Mat {
  const step = layerMatrix(anchor, [anchor[0] + position[0], anchor[1] + position[1]], scalePct, rotationDeg);
  let m: Mat = IDENTITY;
  const whole = Math.floor(k);
  const frac = k - whole;
  const base = whole >= 0 ? step : invert(step);
  for (let i = 0; i < Math.abs(whole); i++) m = multiply(m, base);
  if (frac > 1e-9) {
    const part = layerMatrix(
      anchor,
      [anchor[0] + position[0] * frac, anchor[1] + position[1] * frac],
      [100 * Math.pow(Math.max(1e-6, scalePct[0] / 100), frac), 100 * Math.pow(Math.max(1e-6, scalePct[1] / 100), frac)],
      rotationDeg * frac,
    );
    m = multiply(m, part);
  }
  return m;
}

/**
 * Offset a bezier path by `amount` px (positive grows a closed shape). The
 * curve is flattened to a polyline first, so the result is an approximation
 * that is exact enough for motion graphics; rectangles and ellipses are
 * offset exactly by the evaluator instead.
 */
export function offsetPathD(path: PathData, amount: number, join: "miter" | "round"): string {
  const pts: Vec2[] = [];
  const n = path.points.length;
  if (n < 2) return pathToD(path);
  const segs = path.closed ? n : n - 1;
  const STEPS = 16;
  for (let i = 0; i < segs; i++) {
    const a = path.points[i];
    const b = path.points[(i + 1) % n];
    const c1: Vec2 = [a.p[0] + a.out[0], a.p[1] + a.out[1]];
    const c2: Vec2 = [b.p[0] + b.in[0], b.p[1] + b.in[1]];
    const straight = !a.out[0] && !a.out[1] && !b.in[0] && !b.in[1];
    const steps = straight ? 1 : STEPS;
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      const mu = 1 - u;
      pts.push([
        mu * mu * mu * a.p[0] + 3 * mu * mu * u * c1[0] + 3 * mu * u * u * c2[0] + u * u * u * b.p[0],
        mu * mu * mu * a.p[1] + 3 * mu * mu * u * c1[1] + 3 * mu * u * u * c2[1] + u * u * u * b.p[1],
      ]);
    }
  }
  if (!path.closed) pts.push(path.points[n - 1].p);
  // Drop repeated points so normals are defined.
  const P = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6);
  if (path.closed && P.length > 1 && Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1e-6) P.pop();
  const m = P.length;
  if (m < 2) return pathToD(path);
  // Outward = left of travel for clockwise (screen) shapes; flip by orientation.
  let area = 0;
  for (let i = 0; i < m; i++) {
    const p = P[i];
    const q = P[(i + 1) % m];
    area += p[0] * q[1] - q[0] * p[1];
  }
  const dir = path.closed && area < 0 ? -1 : 1;
  const normal = (p: Vec2, q: Vec2): Vec2 => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    return [(dy / l) * dir, (-dx / l) * dir];
  };
  const out: Vec2[] = [];
  for (let i = 0; i < m; i++) {
    const prev = path.closed ? P[(i - 1 + m) % m] : P[Math.max(0, i - 1)];
    const next = path.closed ? P[(i + 1) % m] : P[Math.min(m - 1, i + 1)];
    const n1 = i === 0 && !path.closed ? normal(P[0], P[1]) : normal(prev, P[i]);
    const n2 = i === m - 1 && !path.closed ? normal(P[m - 2], P[m - 1]) : normal(P[i], next);
    const bx = n1[0] + n2[0];
    const by = n1[1] + n2[1];
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) {
      out.push([P[i][0] + n1[0] * amount, P[i][1] + n1[1] * amount]);
      continue;
    }
    const cos = (n1[0] * n2[0] + n1[1] * n2[1] + 1) / 2; // cos^2 of half angle
    const miter = 1 / Math.sqrt(Math.max(cos, 1e-6));
    // An outer corner (the offset pulls the two edges apart) gets an arc for round joins.
    const outer = Math.sign(amount) * (n1[0] * (next[0] - P[i][0]) + n1[1] * (next[1] - P[i][1])) < 0;
    if (join === "round" && miter > 1.05 && outer) {
      // Outer corner: arc from n1 to n2.
      const a1 = Math.atan2(n1[1], n1[0]);
      let a2 = Math.atan2(n2[1], n2[0]);
      while (a2 - a1 > Math.PI) a2 -= 2 * Math.PI;
      while (a1 - a2 > Math.PI) a2 += 2 * Math.PI;
      for (let s = 0; s <= 6; s++) {
        const a = a1 + ((a2 - a1) * s) / 6;
        out.push([P[i][0] + Math.cos(a) * amount, P[i][1] + Math.sin(a) * amount]);
      }
      continue;
    }
    const k = Math.min(miter, 4) * amount;
    out.push([P[i][0] + (bx / bl) * k, P[i][1] + (by / bl) * k]);
  }
  const f = (x: number) => Math.round(x * 100) / 100;
  return "M" + out.map((p) => `${f(p[0])} ${f(p[1])}`).join("L") + (path.closed ? "Z" : "");
}
