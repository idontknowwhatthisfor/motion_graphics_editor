/**
 * Property addressing. A property is named by a dotted path relative to its
 * layer, e.g.:
 *   transform.position      style.size          fill.paint.color
 *   geometry.0.size         geometry.geo_ab12.size   (array items by index OR id)
 *   masks.mask_x.path       animators.0.selector.start   trim.end
 * The same paths are used by the UI, the Command API and the MCP tools.
 */
import { valueAt } from "./interpolate";
import type { AnimValue, Layer, Prop } from "./types";

export function isProp(x: unknown): x is Prop {
  return typeof x === "object" && x !== null && "value" in x && !Array.isArray(x);
}

function step(obj: unknown, seg: string): unknown {
  if (Array.isArray(obj)) {
    if (/^\d+$/.test(seg)) return obj[Number(seg)];
    return obj.find((it) => it && typeof it === "object" && (it as { id?: string }).id === seg);
  }
  if (obj && typeof obj === "object") return (obj as Record<string, unknown>)[seg];
  return undefined;
}

export function getAt(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split(".")) {
    if (cur === undefined) return undefined;
    cur = step(cur, seg);
  }
  return cur;
}

/** Find an animatable property on a layer; returns undefined if not a Prop. */
export function getProp(layer: Layer, path: string): Prop | undefined {
  const p = getAt(layer, path);
  return isProp(p) ? p : undefined;
}

/** All animatable properties of a layer with their paths (for UI and MCP). */
export function listProps(layer: Layer): { path: string; prop: Prop }[] {
  const out: { path: string; prop: Prop }[] = [];
  const walk = (obj: unknown, path: string) => {
    if (isProp(obj)) {
      out.push({ path, prop: obj });
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((it, i) => {
        const key = it && typeof it === "object" && "id" in it ? String((it as { id: string }).id) : String(i);
        walk(it, path ? `${path}.${key}` : key);
      });
      return;
    }
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (k === "keyframes") continue;
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(layer, "");
  return out;
}

export function propValueAt(layer: Layer, path: string, t: number): AnimValue | undefined {
  const p = getProp(layer, path);
  return p ? valueAt(p, t) : undefined;
}

/** Visit every Prop under an object (used for time shifts and resizes). */
export function forEachProp(obj: unknown, fn: (p: Prop, path: string) => void, path = ""): void {
  if (isProp(obj)) {
    fn(obj, path);
    return;
  }
  if (Array.isArray(obj)) obj.forEach((it, i) => forEachProp(it, fn, `${path}.${i}`));
  else if (obj && typeof obj === "object")
    for (const [k, v] of Object.entries(obj)) if (k !== "keyframes") forEachProp(v, fn, path ? `${path}.${k}` : k);
}
