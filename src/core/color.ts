import type { Color } from "./types";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(c: Color): RGBA {
  let h = c.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = h.split("").map((x) => x + x).join("");
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) return { r: 0, g: 0, b: 0, a: 1 };
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");

export function formatColor({ r, g, b, a }: RGBA): Color {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return a >= 0.9995 ? base : base + hex2(a * 255);
}

export function lerpColor(a: Color, b: Color, u: number): Color {
  const x = parseColor(a);
  const y = parseColor(b);
  return formatColor({
    r: x.r + (y.r - x.r) * u,
    g: x.g + (y.g - x.g) * u,
    b: x.b + (y.b - x.b) * u,
    a: x.a + (y.a - x.a) * u,
  });
}

export function isColor(v: unknown): v is Color {
  return typeof v === "string" && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
}
