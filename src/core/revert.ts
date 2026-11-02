/**
 * Id-based, semantic revert used for undo/redo and for rejecting Claude's
 * change sets.
 *
 * Why not Immer's index-based patches: Claude's change set can stay pending
 * while I keep editing, so edits are not strictly last-in-first-out. A patch
 * like "replace layers[1].rotation" hits the wrong layer once another layer
 * was inserted above it. Instead, every step keeps the immutable project
 * snapshots before and after it (cheap thanks to structural sharing), and
 * `transfer(cur, from, to)` rewrites ONLY the objects that differ between
 * `from` and `to`, matched by id, onto the current project.
 *
 *  - Granularity: project fields, assets, compositions (fields + markers) and
 *    whole layers. If I edited the very same layer Claude changed, rejecting
 *    restores that layer to its pre-Claude state (a conflict, reported back).
 *  - When cur === from, the result is exactly `to` (plain LIFO undo).
 */
import { produce } from "immer";
import type { Composition, Project } from "./types";

type WithId = { id: string };

function transferList<T extends WithId>(cur: T[], from: T[], to: T[], conflicts?: Set<string>): T[] {
  if (from === to) return cur;
  const fm = new Map(from.map((x) => [x.id, x]));
  const tm = new Map(to.map((x) => [x.id, x]));
  const cm = new Map(cur.map((x) => [x.id, x]));
  const out = new Map(cm);
  const ids = new Set([...fm.keys(), ...tm.keys()]);
  let changedMembership = false;
  for (const id of ids) {
    const f = fm.get(id);
    const t = tm.get(id);
    if (f === t) continue;
    if (conflicts && cm.has(id) && f && cm.get(id) !== f) conflicts.add(id);
    if (!t) {
      if (out.delete(id)) changedMembership = true;
    } else {
      if (!out.has(id)) changedMembership = true;
      out.set(id, t);
    }
  }
  // Order: ids known to `to` follow to's order; ids only the current project
  // knows (added since) keep their current neighbours.
  const fromOrder = from.map((x) => x.id).filter((id) => tm.has(id));
  const toOrder = to.map((x) => x.id).filter((id) => fm.has(id));
  const reordered = fromOrder.join("|") !== toOrder.join("|");
  if (!changedMembership && !reordered) return cur.map((x) => out.get(x.id)!);

  const result: string[] = [];
  const toIds = to.map((x) => x.id);
  const placed = new Set<string>();
  // Start from `to`'s order for the ids it has, then splice in current-only ids.
  for (const id of toIds) if (out.has(id)) (result.push(id), placed.add(id));
  cur.forEach((x, i) => {
    if (placed.has(x.id) || !out.has(x.id)) return;
    // insert after the nearest preceding current item that is placed
    let anchor = -1;
    for (let k = i - 1; k >= 0; k--) {
      const idx = result.indexOf(cur[k].id);
      if (idx >= 0) {
        anchor = idx;
        break;
      }
    }
    result.splice(anchor + 1, 0, x.id);
    placed.add(x.id);
  });
  return result.map((id) => out.get(id)!);
}

function transferComp(cur: Composition, from: Composition, to: Composition, conflicts?: Set<string>): Composition {
  if (from === to) return cur;
  return produce(cur, (d) => {
    for (const k of Object.keys(to) as (keyof Composition)[]) {
      if (k === "layers" || k === "markers") continue;
      if (from[k] !== to[k]) (d as Record<string, unknown>)[k] = to[k];
    }
    d.layers = transferList(cur.layers, from.layers, to.layers, conflicts) as typeof d.layers;
    d.markers = transferList(cur.markers, from.markers, to.markers) as typeof d.markers;
  });
}

/** Apply the difference from→to onto cur. Collects ids of conflicting layers. */
export function transfer(cur: Project, from: Project, to: Project, conflicts?: Set<string>): Project {
  if (from === to) return cur;
  if (cur === from) return to;
  return produce(cur, (d) => {
    if (from.name !== to.name) d.name = to.name;
    if (from.activeCompId !== to.activeCompId) d.activeCompId = to.activeCompId;
    if (from.settings !== to.settings) d.settings = to.settings;
    d.assets = transferList(cur.assets, from.assets, to.assets) as typeof d.assets;
    const fm = new Map(from.compositions.map((c) => [c.id, c]));
    const tm = new Map(to.compositions.map((c) => [c.id, c]));
    // Compositions: membership by id, then per-composition transfer.
    const merged = transferList(cur.compositions, from.compositions, to.compositions);
    d.compositions = merged.map((c) => {
      const f = fm.get(c.id);
      const t = tm.get(c.id);
      const live = cur.compositions.find((x) => x.id === c.id);
      if (f && t && live) return transferComp(live, f, t, conflicts);
      return c;
    }) as typeof d.compositions;
    if (!d.compositions.some((c) => c.id === d.activeCompId) && d.compositions.length) d.activeCompId = d.compositions[0].id;
  });
}
