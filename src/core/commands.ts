/**
 * The Command API: the ONLY way the project changes. The editor UI, the MCP
 * server (Claude) and scripts all send these same plain-JSON commands, so
 * anything Claude does can be seen, undone and repeated by hand (principle 2).
 *
 * Each command mutates an Immer draft; the Editor (history.ts) records the
 * resulting patches for undo/redo and change sets.
 */
import { makeComposition, makeEffect, makeGeometry, makeLayer, makeOffsetPath, makeRepeater, prop, type MakeLayerOpts } from "./factory";
import { checkSyntax } from "./expressions";
import { rectPath } from "./geometry";
import { newId } from "./id";
import { valueAt } from "./interpolate";
import { forEachProp, getProp } from "./props";
import type {
  AnimValue,
  Asset,
  Composition,
  BrandKit,
  Ease,
  EffectKind,
  Geometry,
  Keyframe,
  Layer,
  LayerType,
  Marker,
  Mask,
  PermissionMode,
  PrecompLayer,
  Project,
  TemplateField,
  TextAnimator,
  Vec2,
} from "./types";

export class CommandError extends Error {}

// ---------- command shapes ----------
type CompRef = { compId?: string };
type LayerRef = CompRef & { layerId: string };
type PropRef = LayerRef & { path: string };

export type KeyframeInput = { t: number; v: AnimValue; ease?: Ease; spatialIn?: Vec2; spatialOut?: Vec2 };

export type Command =
  | { type: "project.rename"; name: string }
  | { type: "project.setPermissionMode"; mode: PermissionMode }
  | { type: "comp.create"; comp?: Partial<Omit<Composition, "layers" | "markers">>; activate?: boolean }
  | ({ type: "comp.update"; name?: string; fps?: number; duration?: number; background?: string | null } & CompRef)
  | ({ type: "comp.resize"; width: number; height: number; mode: "scaleToFit" | "keepLayout" } & CompRef)
  | ({ type: "comp.duplicate"; name?: string; newId?: string; activate?: boolean } & CompRef)
  | ({ type: "comp.delete" } & CompRef)
  | { type: "comp.setActive"; compId: string }
  | ({ type: "layer.add"; layerType?: LayerType; opts?: MakeLayerOpts; layer?: Layer; index?: number } & CompRef)
  | ({ type: "layer.delete"; layerIds: string[] } & CompRef)
  | ({ type: "layer.update"; patch: Record<string, unknown> } & LayerRef)
  | ({ type: "layer.reorder"; toIndex: number } & LayerRef)
  | ({ type: "layer.duplicate"; newId?: string } & LayerRef)
  | ({ type: "layer.split"; t: number; newId?: string } & LayerRef)
  | ({ type: "layer.shiftTime"; layerIds: string[]; delta: number } & CompRef)
  | ({ type: "prop.set"; value: AnimValue; t?: number } & PropRef)
  | ({ type: "prop.setKeyframes"; keyframes: KeyframeInput[] } & PropRef)
  | ({ type: "keyframe.add"; t: number; v?: AnimValue; ease?: Ease } & PropRef)
  | ({ type: "keyframe.remove"; keyframeIds: string[] } & PropRef)
  | ({ type: "keyframe.move"; keyframeIds: string[]; delta: number } & PropRef)
  | ({
      type: "keyframe.update";
      keyframeId: string;
      v?: AnimValue;
      t?: number;
      ease?: Ease;
      spatialIn?: Vec2 | null;
      spatialOut?: Vec2 | null;
    } & PropRef)
  | ({ type: "keyframe.setEase"; keyframeIds?: string[]; ease: Ease } & PropRef)
  | ({ type: "prop.clearKeyframes" } & PropRef)
  | ({ type: "marker.add"; t: number; label?: string; color?: string; id?: string } & CompRef)
  | ({ type: "marker.update"; markerId: string; t?: number; label?: string } & CompRef)
  | ({ type: "marker.remove"; markerId: string } & CompRef)
  | ({ type: "mask.add"; mode?: Mask["mode"]; rect?: [number, number, number, number]; id?: string } & LayerRef)
  | ({ type: "mask.update"; maskId: string; patch: Partial<Pick<Mask, "mode" | "inverted" | "name">> } & LayerRef)
  | ({ type: "mask.remove"; maskId: string } & LayerRef)
  | ({ type: "geometry.add"; kind: Geometry["kind"]; size?: Vec2; id?: string } & LayerRef)
  | ({ type: "geometry.remove"; geometryId: string } & LayerRef)
  | ({ type: "animator.add"; preset?: "fadeIn" | "slideUp" | "scaleIn" | "blank"; id?: string } & LayerRef)
  | ({ type: "animator.remove"; animatorId: string } & LayerRef)
  | { type: "brand.set"; brand: BrandKit | null }
  | ({ type: "template.addField"; layerId: string; path: string; name: string; id?: string } & CompRef)
  | ({ type: "template.updateField"; fieldId: string; name: string } & CompRef)
  | ({ type: "template.removeField"; fieldId: string } & CompRef)
  | ({ type: "template.fill"; values: Record<string, unknown> } & CompRef)
  | ({ type: "layer.setVideoRole"; role: "video" | "reference" } & LayerRef)
  | ({ type: "prop.setExpression"; expression: string | null } & PropRef)
  | ({ type: "shape.addOperator"; operator: "repeater" | "offsetPath" } & LayerRef)
  | ({ type: "shape.removeOperator"; operator: "repeater" | "offsetPath" } & LayerRef)
  | ({ type: "effect.add"; kind: EffectKind; index?: number; id?: string } & LayerRef)
  | ({ type: "effect.update"; effectId: string; enabled?: boolean; gradient?: "linear" | "radial"; toIndex?: number } & LayerRef)
  | ({ type: "effect.remove"; effectId: string } & LayerRef)
  | ({ type: "comp.precompose"; layerIds: string[]; name?: string; newCompId?: string; newLayerId?: string } & CompRef)
  | { type: "asset.add"; asset: Asset }
  | { type: "asset.remove"; assetId: string };

export type CommandType = Command["type"];

// ---------- helpers ----------
export function getComp(p: Project, compId?: string): Composition {
  const id = compId ?? p.activeCompId;
  const c = p.compositions.find((x) => x.id === id);
  if (!c) throw new CommandError(`Composition not found: ${id}`);
  return c;
}
export function getLayer(c: Composition, layerId: string): Layer {
  const l = c.layers.find((x) => x.id === layerId);
  if (!l) throw new CommandError(`Layer not found: ${layerId}`);
  return l;
}
function needProp(l: Layer, path: string) {
  const p = getProp(l, path);
  if (!p) throw new CommandError(`Property not found on layer "${l.name}": ${path}`);
  return p;
}
function finite(n: unknown, what: string): number {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new CommandError(`${what} must be a finite number`);
  return n;
}

/** Check that a new value has the same kind as the property's current value. */
function checkValueType(current: AnimValue, v: AnimValue, path: string) {
  const kind = (x: AnimValue) =>
    typeof x === "number" ? "number" : typeof x === "string" ? "color" : Array.isArray(x) ? "vec2" : "path";
  if (kind(current) !== kind(v)) throw new CommandError(`Value for ${path} must be a ${kind(current)}, got ${kind(v)}`);
  if (Array.isArray(v) && (v.length !== 2 || !v.every((n) => Number.isFinite(n))))
    throw new CommandError(`Value for ${path} must be [x, y]`);
  if (typeof v === "number" && !Number.isFinite(v)) throw new CommandError(`Value for ${path} must be finite`);
  if (typeof v === "string" && !/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v))
    throw new CommandError(`Colour for ${path} must be #rrggbb or #rrggbbaa`);
}

const TIME_EPS = 1e-6;
function upsertKeyframe(p: { value: AnimValue; keyframes?: Keyframe[] }, t: number, v: AnimValue, ease?: Ease) {
  p.keyframes ??= [];
  const existing = p.keyframes.find((k) => Math.abs(k.t - t) < TIME_EPS);
  if (existing) {
    existing.v = v;
    if (ease) existing.ease = ease;
    return existing.id;
  }
  const kf: Keyframe = { id: newId("kf"), t, v, ease: ease ?? { kind: "linear" } };
  p.keyframes.push(kf);
  p.keyframes.sort((a, b) => a.t - b.t);
  return kf.id;
}

const PATCHABLE_LAYER_KEYS = new Set([
  "name",
  "parentId",
  "inPoint",
  "outPoint",
  "visible",
  "locked",
  "blendMode",
  "matte",
  "label",
  "text",
  "combine",
  "style",
  "fill",
  "stroke",
  "trim",
  "width",
  "height",
  "assetId",
  "mediaOffset",
  "animators",
  "compId",
  "timeOffset",
  "repeater",
  "offsetPath",
  "linkId",
]);

/**
 * Deep-merge plain objects; arrays and primitives replace. An object whose
 * `kind` differs from the current one (e.g. solid -> linear paint) replaces it.
 */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    const cur = target[k];
    const sameKind = !(v && typeof v === "object" && "kind" in v && cur && typeof cur === "object" && (cur as { kind?: unknown }).kind !== (v as { kind?: unknown }).kind);
    if (sameKind && v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur))
      deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = v as unknown;
  }
}

function wouldCycle(c: Composition, layerId: string, parentId: string | null): boolean {
  let cur = parentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === layerId) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = c.layers.find((l) => l.id === cur)?.parentId ?? null;
  }
  return false;
}

/** Does comp `fromId` (transitively) contain a precomp of `targetId`? */
export function compContains(p: Project, fromId: string, targetId: string, seen = new Set<string>()): boolean {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const c = p.compositions.find((x) => x.id === fromId);
  if (!c) return false;
  return c.layers.some((l) => l.type === "precomp" && compContains(p, l.compId, targetId, seen));
}
function checkPrecomp(p: Project, host: Composition, compId: string) {
  if (!p.compositions.some((c) => c.id === compId)) throw new CommandError(`Composition not found: ${compId}`);
  if (compContains(p, compId, host.id)) throw new CommandError("Nesting this composition would create a loop");
}

function cloneWithNewIds<T>(x: T): T {
  const copy = JSON.parse(JSON.stringify(x)) as T;
  const walk = (o: unknown) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      if (typeof r.id === "string" && r.id.includes("_")) r.id = newId(String(r.id).split("_")[0]);
      Object.values(r).forEach(walk);
    }
  };
  walk(copy);
  return copy;
}

function animatorPreset(preset: string, id?: string): TextAnimator {
  const base: TextAnimator = {
    id: id ?? newId("anim"),
    name: "Animator",
    selector: { basedOn: "characters", shape: "square", start: prop(0), end: prop(100), offset: prop(0) },
    props: {},
  };
  if (preset === "fadeIn") {
    base.name = "Fade in";
    base.props.opacity = prop(0);
  } else if (preset === "slideUp") {
    base.name = "Slide up";
    base.props.opacity = prop(0);
    base.props.position = prop<Vec2>([0, 60]);
  } else if (preset === "scaleIn") {
    base.name = "Scale in";
    base.props.opacity = prop(0);
    base.props.scale = prop<Vec2>([0, 0]);
  }
  return base;
}

/** The layers in `ids` plus every layer linked to one of them (see Layer.linkId), in comp order. */
function withLinked(c: Composition, ids: Iterable<string>): string[] {
  const want = new Set(ids);
  const links = new Set(c.layers.filter((l) => want.has(l.id) && l.linkId).map((l) => l.linkId));
  return c.layers.filter((l) => want.has(l.id) || (l.linkId && links.has(l.linkId))).map((l) => l.id);
}

/** Media layers and nested comps play their source from mediaOffset / timeOffset at their inPoint. */
function sourceOffsetKey(l: Layer): "mediaOffset" | "timeOffset" | null {
  return l.type === "video" || l.type === "audio" || l.type === "reference" ? "mediaOffset" : l.type === "precomp" ? "timeOffset" : null;
}

// ---------- the reducer ----------
/** Applies one command to a draft. Returns an optional result (e.g. new ids). */
export function applyCommand(p: Project, cmd: Command): unknown {
  switch (cmd.type) {
    case "project.rename":
      p.name = String(cmd.name);
      return;
    case "project.setPermissionMode":
      if (!["readOnly", "ask", "autoKeep"].includes(cmd.mode)) throw new CommandError("Unknown permission mode");
      p.settings.permissionMode = cmd.mode;
      return;

    case "comp.create": {
      const c = makeComposition(cmd.comp ?? {});
      if (cmd.comp?.id && p.compositions.some((x) => x.id === cmd.comp!.id)) throw new CommandError("Composition id exists");
      validateCompNumbers(c);
      p.compositions.push(c);
      if (cmd.activate !== false) p.activeCompId = c.id;
      return { compId: c.id };
    }
    case "comp.update": {
      const c = getComp(p, cmd.compId);
      if (cmd.name !== undefined) c.name = String(cmd.name);
      // fps change: keyframes are stored in seconds, so timing is unchanged (ED-24).
      if (cmd.fps !== undefined) c.fps = finite(cmd.fps, "fps");
      if (cmd.duration !== undefined) c.duration = finite(cmd.duration, "duration");
      if (cmd.background !== undefined) c.background = cmd.background;
      validateCompNumbers(c);
      return;
    }
    case "comp.resize": {
      const c = getComp(p, cmd.compId);
      const W = finite(cmd.width, "width");
      const H = finite(cmd.height, "height");
      if (W < 16 || H < 16 || W > 8192 || H > 8192) throw new CommandError("Size must be between 16 and 8192 px");
      const oc: Vec2 = [c.width / 2, c.height / 2];
      const nc: Vec2 = [W / 2, H / 2];
      const s = cmd.mode === "scaleToFit" ? Math.min(W / c.width, H / c.height) : 1;
      const mapPos = (v: Vec2): Vec2 => [(v[0] - oc[0]) * s + nc[0], (v[1] - oc[1]) * s + nc[1]];
      for (const l of c.layers) {
        if (l.parentId) continue; // children follow their parent
        const pos = l.transform.position;
        pos.value = mapPos(pos.value);
        pos.keyframes?.forEach((k) => {
          k.v = mapPos(k.v);
          if (k.spatialIn) k.spatialIn = [k.spatialIn[0] * s, k.spatialIn[1] * s];
          if (k.spatialOut) k.spatialOut = [k.spatialOut[0] * s, k.spatialOut[1] * s];
        });
        if (s !== 1) {
          const sc = l.transform.scale;
          sc.value = [sc.value[0] * s, sc.value[1] * s];
          sc.keyframes?.forEach((k) => (k.v = [k.v[0] * s, k.v[1] * s]));
        }
      }
      c.width = Math.round(W);
      c.height = Math.round(H);
      return;
    }
    case "comp.duplicate": {
      const src = getComp(p, cmd.compId);
      const copy = cloneWithNewIds(src);
      // Layer ids change, so re-point parents and mattes at the copies.
      const idMap = new Map(src.layers.map((l, i) => [l.id, copy.layers[i].id]));
      for (const l of copy.layers) {
        if (l.parentId) l.parentId = idMap.get(l.parentId) ?? null;
        if (l.matte) l.matte = { ...l.matte, layerId: idMap.get(l.matte.layerId) ?? l.matte.layerId };
      }
      if (copy.template) copy.template.fields = copy.template.fields.map((f) => ({ ...f, id: newId("field"), layerId: idMap.get(f.layerId) ?? f.layerId }));
      copy.id = cmd.newId ?? newId("comp");
      if (p.compositions.some((c) => c.id === copy.id)) throw new CommandError("Composition id exists");
      copy.name = cmd.name ?? `${src.name} copy`;
      p.compositions.push(copy);
      if (cmd.activate) p.activeCompId = copy.id;
      return { compId: copy.id };
    }
    case "comp.delete": {
      if (p.compositions.length <= 1) throw new CommandError("A project needs at least one composition");
      const c = getComp(p, cmd.compId);
      const user = p.compositions.find((x) => x.id !== c.id && x.layers.some((l) => l.type === "precomp" && l.compId === c.id));
      if (user) throw new CommandError(`"${c.name}" is nested in "${user.name}"; remove that layer first`);
      p.compositions = p.compositions.filter((x) => x.id !== c.id);
      if (p.activeCompId === c.id) p.activeCompId = p.compositions[0].id;
      return;
    }
    case "comp.setActive":
      getComp(p, cmd.compId);
      p.activeCompId = cmd.compId;
      return;

    case "layer.add": {
      const c = getComp(p, cmd.compId);
      let layer: Layer;
      if (cmd.layer) {
        layer = JSON.parse(JSON.stringify(cmd.layer)) as Layer;
        if (!layer.id) layer.id = newId("layer");
        if (c.layers.some((l) => l.id === layer.id)) throw new CommandError(`Layer id exists: ${layer.id}`);
      } else {
        if (!cmd.layerType) throw new CommandError("layer.add needs layerType or layer");
        layer = makeLayer(cmd.layerType, c, cmd.opts ?? {});
        if (cmd.opts && (cmd.opts as { id?: string }).id) layer.id = (cmd.opts as { id?: string }).id!;
      }
      if ("assetId" in layer && !p.assets.some((a) => a.id === layer.assetId))
        throw new CommandError(`Asset not found: ${(layer as { assetId: string }).assetId}`);
      if (layer.type === "precomp") {
        checkPrecomp(p, c, layer.compId);
        if (!cmd.layer && !cmd.opts?.width) {
          const child = getComp(p, layer.compId);
          layer.transform.anchor.value = [child.width / 2, child.height / 2];
          if (!cmd.opts?.name) layer.name = child.name;
        }
      }
      const idx = Math.max(0, Math.min(c.layers.length, cmd.index ?? 0));
      c.layers.splice(idx, 0, layer);
      return { layerId: layer.id };
    }
    case "layer.delete": {
      const c = getComp(p, cmd.compId);
      for (const id of cmd.layerIds) getLayer(c, id);
      const ids = new Set(withLinked(c, cmd.layerIds));
      c.layers = c.layers.filter((l) => !ids.has(l.id));
      for (const l of c.layers) {
        if (l.parentId && ids.has(l.parentId)) l.parentId = null;
        if (l.matte && ids.has(l.matte.layerId)) l.matte = null;
      }
      if (c.template) {
        c.template.fields = c.template.fields.filter((f) => !ids.has(f.layerId));
        if (!c.template.fields.length) delete c.template;
      }
      return;
    }
    case "layer.update": {
      const c = getComp(p, cmd.compId);
      const l = getLayer(c, cmd.layerId);
      for (const k of Object.keys(cmd.patch))
        if (!PATCHABLE_LAYER_KEYS.has(k)) throw new CommandError(`Cannot patch "${k}" with layer.update; use prop.set for animatable values`);
      if ("parentId" in cmd.patch) {
        const pid = cmd.patch.parentId as string | null;
        if (pid !== null) getLayer(c, pid);
        if (wouldCycle(c, l.id, pid)) throw new CommandError("Parenting would create a cycle");
      }
      if ("compId" in cmd.patch || "timeOffset" in cmd.patch) {
        if (l.type !== "precomp") throw new CommandError("compId and timeOffset only apply to nested comp layers");
        if ("compId" in cmd.patch) checkPrecomp(p, c, String(cmd.patch.compId));
        if ("timeOffset" in cmd.patch) finite(cmd.patch.timeOffset, "timeOffset");
      }
      if ("matte" in cmd.patch && cmd.patch.matte) {
        const m = cmd.patch.matte as { layerId: string };
        getLayer(c, m.layerId);
        if (m.layerId === l.id) throw new CommandError("A layer cannot be its own matte");
      }
      const before = { inPoint: l.inPoint, outPoint: l.outPoint, mediaOffset: "mediaOffset" in l ? l.mediaOffset : 0 };
      deepMerge(l as unknown as Record<string, unknown>, cmd.patch);
      // Trimming the start cuts the footage/sound/nested comp instead of sliding it: the
      // source offset moves with the inPoint (as in layer.split) unless the patch sets the
      // offset itself. Media cannot start before its first frame, so that trim stops there.
      const key = sourceOffsetKey(l);
      const slip = key !== null && "inPoint" in cmd.patch && !(key in cmd.patch);
      if (slip) {
        if (key === "mediaOffset") l.inPoint = Math.max(l.inPoint, before.inPoint - before.mediaOffset);
        (l as unknown as Record<string, number>)[key] += l.inPoint - before.inPoint;
      }
      if (!(l.inPoint < l.outPoint)) throw new CommandError("inPoint must be before outPoint");
      // Trims and slips carry over to linked layers as the same change.
      for (const id of withLinked(c, [l.id])) {
        const o = getLayer(c, id);
        if (o === l) continue;
        if ("inPoint" in cmd.patch) o.inPoint += l.inPoint - before.inPoint;
        if ("outPoint" in cmd.patch) o.outPoint += l.outPoint - before.outPoint;
        if ("mediaOffset" in cmd.patch && "mediaOffset" in o && "mediaOffset" in l) o.mediaOffset = Math.max(0, o.mediaOffset + l.mediaOffset - before.mediaOffset);
        if (slip && "mediaOffset" in o) o.mediaOffset = Math.max(0, o.mediaOffset + l.inPoint - before.inPoint);
        if (!(o.inPoint < o.outPoint)) throw new CommandError(`That trim would leave the linked layer "${o.name}" with no length`);
      }
      return;
    }
    case "layer.reorder": {
      const c = getComp(p, cmd.compId);
      const i = c.layers.findIndex((l) => l.id === cmd.layerId);
      if (i < 0) throw new CommandError(`Layer not found: ${cmd.layerId}`);
      const [l] = c.layers.splice(i, 1);
      c.layers.splice(Math.max(0, Math.min(c.layers.length, cmd.toIndex)), 0, l);
      return;
    }
    case "layer.duplicate": {
      const c = getComp(p, cmd.compId);
      getLayer(c, cmd.layerId);
      // A linked group is duplicated as a group, linked to itself but not to the original.
      const link = c.layers.find((l) => l.id === cmd.layerId)!.linkId ? newId("link") : undefined;
      let result = "";
      for (const id of withLinked(c, [cmd.layerId])) {
        const i = c.layers.findIndex((l) => l.id === id);
        const copy = cloneWithNewIds(c.layers[i]);
        copy.id = id === cmd.layerId ? (cmd.newId ?? newId("layer")) : newId("layer");
        copy.name = `${c.layers[i].name} copy`;
        if (link) copy.linkId = link;
        c.layers.splice(i, 0, copy);
        if (id === cmd.layerId) result = copy.id;
      }
      return { layerId: result };
    }
    case "layer.split": {
      const c = getComp(p, cmd.compId);
      const l = getLayer(c, cmd.layerId);
      const t = finite(cmd.t, "t");
      if (!(t > l.inPoint && t < l.outPoint)) throw new CommandError("Split time must be inside the layer");
      const link = l.linkId ? newId("link") : undefined;
      let result = "";
      for (const id of withLinked(c, [l.id])) {
        const j = c.layers.findIndex((x) => x.id === id);
        const src = c.layers[j];
        if (!(t > src.inPoint && t < src.outPoint)) continue; // a linked layer that ends earlier is left alone
        const copy = cloneWithNewIds(src);
        copy.id = id === l.id ? (cmd.newId ?? newId("layer")) : newId("layer");
        copy.inPoint = t;
        // The second half continues the footage/sound/nested comp where the first stops.
        const key = sourceOffsetKey(copy);
        if (key) (copy as unknown as Record<string, number>)[key] += t - src.inPoint;
        if (link) copy.linkId = link;
        src.outPoint = t;
        c.layers.splice(j, 0, copy);
        if (id === l.id) result = copy.id;
      }
      return { layerId: result };
    }
    case "layer.shiftTime": {
      const c = getComp(p, cmd.compId);
      const d = finite(cmd.delta, "delta");
      for (const id of cmd.layerIds) getLayer(c, id);
      for (const id of withLinked(c, cmd.layerIds)) {
        const l = getLayer(c, id);
        l.inPoint += d;
        l.outPoint += d;
        forEachProp(l, (pr) => pr.keyframes?.forEach((k) => (k.t += d)));
      }
      return;
    }

    case "prop.set": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const pr = needProp(l, cmd.path);
      checkValueType(pr.value, cmd.value, cmd.path);
      if (pr.keyframes && pr.keyframes.length > 0) {
        if (cmd.t === undefined) throw new CommandError(`${cmd.path} is animated; pass t to set a keyframe`);
        return { keyframeId: upsertKeyframe(pr, finite(cmd.t, "t"), cmd.value) };
      }
      pr.value = cmd.value;
      return;
    }
    case "prop.setKeyframes": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const pr = needProp(l, cmd.path);
      for (const k of cmd.keyframes) {
        finite(k.t, "keyframe t");
        checkValueType(pr.value, k.v, cmd.path);
      }
      if (cmd.keyframes.length === 0) {
        if (pr.keyframes?.length) pr.value = pr.keyframes[0].v;
        delete pr.keyframes;
        return { keyframeIds: [] };
      }
      pr.keyframes = [...cmd.keyframes]
        .sort((a, b) => a.t - b.t)
        .map((k) => ({
          id: newId("kf"),
          t: k.t,
          v: k.v,
          ease: k.ease ?? { kind: "linear" },
          ...(k.spatialIn ? { spatialIn: k.spatialIn } : {}),
          ...(k.spatialOut ? { spatialOut: k.spatialOut } : {}),
        }));
      pr.value = pr.keyframes[0].v;
      return { keyframeIds: pr.keyframes.map((k) => k.id) };
    }
    case "keyframe.add": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const pr = needProp(l, cmd.path);
      const t = finite(cmd.t, "t");
      const v = cmd.v ?? valueAt(pr, t);
      checkValueType(pr.value, v, cmd.path);
      return { keyframeId: upsertKeyframe(pr, t, v, cmd.ease) };
    }
    case "keyframe.remove": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const pr = needProp(l, cmd.path);
      const ids = new Set(cmd.keyframeIds);
      const remaining = (pr.keyframes ?? []).filter((k) => !ids.has(k.id));
      if (remaining.length === 0) {
        if (pr.keyframes?.length) pr.value = pr.keyframes[0].v;
        delete pr.keyframes;
      } else pr.keyframes = remaining;
      return;
    }
    case "keyframe.move": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const pr = needProp(l, cmd.path);
      const ids = new Set(cmd.keyframeIds);
      const d = finite(cmd.delta, "delta");
      pr.keyframes?.forEach((k) => ids.has(k.id) && (k.t = Math.max(0, k.t + d)));
      pr.keyframes?.sort((a, b) => a.t - b.t);
      return;
    }
    case "keyframe.update": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const pr = needProp(l, cmd.path);
      const k = pr.keyframes?.find((x) => x.id === cmd.keyframeId);
      if (!k) throw new CommandError(`Keyframe not found: ${cmd.keyframeId}`);
      if (cmd.v !== undefined) {
        checkValueType(pr.value, cmd.v, cmd.path);
        k.v = cmd.v;
      }
      if (cmd.t !== undefined) k.t = Math.max(0, finite(cmd.t, "t"));
      if (cmd.ease) k.ease = cmd.ease;
      if (cmd.spatialIn !== undefined) cmd.spatialIn === null ? delete k.spatialIn : (k.spatialIn = cmd.spatialIn);
      if (cmd.spatialOut !== undefined) cmd.spatialOut === null ? delete k.spatialOut : (k.spatialOut = cmd.spatialOut);
      pr.keyframes!.sort((a, b) => a.t - b.t);
      return;
    }
    case "keyframe.setEase": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const pr = needProp(l, cmd.path);
      const ids = cmd.keyframeIds ? new Set(cmd.keyframeIds) : null;
      pr.keyframes?.forEach((k) => (!ids || ids.has(k.id)) && (k.ease = { ...cmd.ease }));
      return;
    }
    case "prop.clearKeyframes": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const pr = needProp(l, cmd.path);
      delete pr.keyframes;
      return;
    }

    case "marker.add": {
      const c = getComp(p, cmd.compId);
      const m: Marker = { id: cmd.id ?? newId("mk"), t: finite(cmd.t, "t"), label: cmd.label ?? "" };
      if (cmd.color) m.color = cmd.color;
      c.markers.push(m);
      c.markers.sort((a, b) => a.t - b.t);
      return { markerId: m.id };
    }
    case "marker.update": {
      const c = getComp(p, cmd.compId);
      const m = c.markers.find((x) => x.id === cmd.markerId);
      if (!m) throw new CommandError("Marker not found");
      if (cmd.t !== undefined) m.t = finite(cmd.t, "t");
      if (cmd.label !== undefined) m.label = cmd.label;
      c.markers.sort((a, b) => a.t - b.t);
      return;
    }
    case "marker.remove": {
      const c = getComp(p, cmd.compId);
      c.markers = c.markers.filter((m) => m.id !== cmd.markerId);
      return;
    }

    case "mask.add": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const [x, y, w, h] = cmd.rect ?? [-200, -100, 400, 200];
      const m: Mask = {
        id: cmd.id ?? newId("mask"),
        name: `Mask ${l.masks.length + 1}`,
        mode: cmd.mode ?? "add",
        inverted: false,
        path: prop(rectPath(x, y, w, h)),
        opacity: prop(100),
        feather: prop(0),
      };
      l.masks.push(m);
      return { maskId: m.id };
    }
    case "mask.update": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const m = l.masks.find((x) => x.id === cmd.maskId);
      if (!m) throw new CommandError("Mask not found");
      Object.assign(m, cmd.patch);
      return;
    }
    case "mask.remove": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      l.masks = l.masks.filter((m) => m.id !== cmd.maskId);
      return;
    }
    case "geometry.add": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      if (l.type !== "shape") throw new CommandError("geometry.add needs a shape layer");
      const g = makeGeometry(cmd.kind, cmd.size);
      if (cmd.id) g.id = cmd.id;
      l.geometry.push(g);
      return { geometryId: g.id };
    }
    case "geometry.remove": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      if (l.type !== "shape") throw new CommandError("Not a shape layer");
      l.geometry = l.geometry.filter((g) => g.id !== cmd.geometryId);
      return;
    }
    case "animator.add": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      if (l.type !== "text") throw new CommandError("Text animators need a text layer");
      const a = animatorPreset(cmd.preset ?? "fadeIn", cmd.id);
      l.animators.push(a);
      return { animatorId: a.id };
    }
    case "animator.remove": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      if (l.type !== "text") throw new CommandError("Not a text layer");
      l.animators = l.animators.filter((a) => a.id !== cmd.animatorId);
      return;
    }
    case "layer.setVideoRole": {
      const c = getComp(p, cmd.compId);
      const i = c.layers.findIndex((l) => l.id === cmd.layerId);
      if (i < 0) throw new CommandError(`Layer not found: ${cmd.layerId}`);
      const l = c.layers[i];
      if (l.type !== "video" && l.type !== "reference") throw new CommandError("Only video layers can switch between exported video and reference");
      if (cmd.role !== "video" && cmd.role !== "reference") throw new CommandError("role must be video or reference");
      c.layers[i] = { ...l, type: cmd.role } as Layer;
      return;
    }
    case "brand.set": {
      if (cmd.brand === null) {
        delete p.brand;
        return;
      }
      const b = cmd.brand;
      if (!b || typeof b.name !== "string" || !Array.isArray(b.colors) || !Array.isArray(b.fonts)) throw new CommandError("A brand kit needs name, colors and fonts");
      const names = new Set<string>();
      for (const c of b.colors) {
        if (!c.name?.trim()) throw new CommandError("Every brand colour needs a name");
        if (names.has(c.name)) throw new CommandError(`Duplicate brand colour "${c.name}"`);
        names.add(c.name);
        checkValueType("#000000", c.color, `brand colour ${c.name}`);
      }
      for (const fo of b.fonts) if (!fo.name?.trim() || !fo.family?.trim()) throw new CommandError("Every brand font needs a name and a family");
      p.brand = {
        name: b.name.slice(0, 80),
        colors: b.colors.map((c) => ({ name: c.name.slice(0, 40), color: c.color })),
        fonts: b.fonts.map((fo) => ({ name: fo.name.slice(0, 40), family: fo.family.slice(0, 200), weight: Number(fo.weight) || 400 })),
      };
      return;
    }
    case "template.addField": {
      const c = getComp(p, cmd.compId);
      const l = getLayer(c, cmd.layerId);
      let kind: TemplateField["kind"];
      if (cmd.path === "text") {
        if (l.type !== "text") throw new CommandError("Only text layers have a text field");
        kind = "text";
      } else {
        const pr = needProp(l, cmd.path);
        const v = pr.value;
        kind = typeof v === "number" ? "number" : typeof v === "string" ? "color" : Array.isArray(v) ? "vec2" : (() => {
          throw new CommandError("Paths cannot be template fields");
        })();
      }
      if (!cmd.name?.trim()) throw new CommandError("A field needs a name");
      c.template ??= { fields: [] };
      if (c.template.fields.some((f) => f.name === cmd.name.trim())) throw new CommandError(`There is already a field named "${cmd.name.trim()}"`);
      const field: TemplateField = { id: cmd.id ?? newId("field"), name: cmd.name.trim().slice(0, 60), layerId: l.id, path: cmd.path, kind };
      c.template.fields.push(field);
      return { fieldId: field.id };
    }
    case "template.updateField": {
      const c = getComp(p, cmd.compId);
      const f = c.template?.fields.find((x) => x.id === cmd.fieldId);
      if (!f) throw new CommandError(`Field not found: ${cmd.fieldId}`);
      if (!cmd.name?.trim()) throw new CommandError("A field needs a name");
      f.name = cmd.name.trim().slice(0, 60);
      return;
    }
    case "template.removeField": {
      const c = getComp(p, cmd.compId);
      if (!c.template) throw new CommandError("This composition is not a template");
      c.template.fields = c.template.fields.filter((x) => x.id !== cmd.fieldId);
      if (!c.template.fields.length) delete c.template;
      return;
    }
    case "template.fill": {
      const c = getComp(p, cmd.compId);
      const fields = c.template?.fields ?? [];
      for (const [key, v] of Object.entries(cmd.values ?? {})) {
        const f = fields.find((x) => x.id === key) ?? fields.find((x) => x.name.toLowerCase() === key.toLowerCase());
        if (!f) throw new CommandError(`No template field "${key}" (fields: ${fields.map((x) => x.name).join(", ") || "none"})`);
        const l = getLayer(c, f.layerId);
        if (f.kind === "text") {
          if (l.type !== "text") throw new CommandError(`Field "${f.name}" no longer points at a text layer`);
          if (typeof v !== "string") throw new CommandError(`Field "${f.name}" needs text`);
          l.text = v.slice(0, 10000);
          continue;
        }
        const pr = needProp(l, f.path);
        checkValueType(pr.value, v as AnimValue, f.name);
        if (pr.keyframes?.length) {
          // An animated field keeps its motion: shift every keyframe by the change at the first one.
          if (typeof v === "string") pr.keyframes.forEach((k) => (k.v = v));
          else {
            const d = typeof v === "number" ? v - (pr.keyframes[0].v as number) : [(v as Vec2)[0] - (pr.keyframes[0].v as Vec2)[0], (v as Vec2)[1] - (pr.keyframes[0].v as Vec2)[1]];
            pr.keyframes.forEach((k) => (k.v = typeof d === "number" ? (k.v as number) + d : [(k.v as Vec2)[0] + d[0], (k.v as Vec2)[1] + d[1]]));
          }
        }
        pr.value = v as AnimValue;
      }
      return;
    }
    case "prop.setExpression": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const pr = needProp(l, cmd.path);
      const src = cmd.expression?.trim() ?? "";
      if (!src) {
        delete pr.expression;
        return;
      }
      if (src.length > 4000) throw new CommandError("Expression is too long (4000 characters max)");
      const kind = typeof pr.value;
      if (kind !== "number" && kind !== "string" && !Array.isArray(pr.value))
        throw new CommandError("Expressions work on numbers, positions/sizes and colours, not paths");
      try {
        checkSyntax(src);
      } catch (e) {
        throw new CommandError(`Expression error: ${(e as Error).message}`);
      }
      pr.expression = src;
      return;
    }
    case "shape.addOperator":
    case "shape.removeOperator": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      if (l.type !== "shape") throw new CommandError("Repeaters and offset paths need a shape layer");
      if (cmd.operator !== "repeater" && cmd.operator !== "offsetPath") throw new CommandError(`Unknown operator: ${cmd.operator}`);
      if (cmd.type === "shape.removeOperator") delete l[cmd.operator];
      else if (cmd.operator === "repeater") l.repeater ??= makeRepeater();
      else l.offsetPath ??= makeOffsetPath();
      return;
    }
    case "effect.add": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const kinds: EffectKind[] = ["blur", "glow", "dropShadow", "colorCorrect", "gradientOverlay"];
      if (!kinds.includes(cmd.kind)) throw new CommandError(`Unknown effect: ${cmd.kind}`);
      const e = makeEffect(cmd.kind, cmd.id);
      l.effects ??= [];
      if (l.effects.some((x) => x.id === e.id)) throw new CommandError("Effect id exists");
      l.effects.splice(Math.max(0, Math.min(l.effects.length, cmd.index ?? l.effects.length)), 0, e);
      return { effectId: e.id };
    }
    case "effect.update": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      const fx = l.effects ?? [];
      const i = fx.findIndex((x) => x.id === cmd.effectId);
      if (i < 0) throw new CommandError(`Effect not found: ${cmd.effectId}`);
      const e = fx[i];
      if (cmd.enabled !== undefined) e.enabled = !!cmd.enabled;
      if (cmd.gradient !== undefined) {
        if (e.kind !== "gradientOverlay") throw new CommandError("gradient only applies to gradientOverlay");
        e.gradient = cmd.gradient === "radial" ? "radial" : "linear";
      }
      if (cmd.toIndex !== undefined) {
        fx.splice(i, 1);
        fx.splice(Math.max(0, Math.min(fx.length, cmd.toIndex)), 0, e);
      }
      return;
    }
    case "effect.remove": {
      const l = getLayer(getComp(p, cmd.compId), cmd.layerId);
      if (!(l.effects ?? []).some((x) => x.id === cmd.effectId)) throw new CommandError(`Effect not found: ${cmd.effectId}`);
      l.effects = l.effects!.filter((x) => x.id !== cmd.effectId);
      return;
    }
    case "comp.precompose": {
      const c = getComp(p, cmd.compId);
      if (!cmd.layerIds.length) throw new CommandError("Pick at least one layer to precompose");
      const ids = new Set(cmd.layerIds);
      for (const id of ids) getLayer(c, id);
      const moved = c.layers.filter((l) => ids.has(l.id));
      const firstIdx = c.layers.findIndex((l) => ids.has(l.id));
      const child = makeComposition({
        id: cmd.newCompId,
        name: cmd.name ?? `${moved[0].name} comp`,
        width: c.width,
        height: c.height,
        fps: c.fps,
        duration: c.duration,
        background: null,
      });
      if (p.compositions.some((x) => x.id === child.id)) throw new CommandError("Composition id exists");
      child.layers = moved.map((l) => JSON.parse(JSON.stringify(l)) as Layer);
      // Links that leave the moved set are cut on both sides.
      for (const l of child.layers) {
        if (l.parentId && !ids.has(l.parentId)) l.parentId = null;
        if (l.matte && !ids.has(l.matte.layerId)) l.matte = null;
      }
      c.layers = c.layers.filter((l) => !ids.has(l.id));
      for (const l of c.layers) {
        if (l.parentId && ids.has(l.parentId)) l.parentId = null;
        if (l.matte && ids.has(l.matte.layerId)) l.matte = null;
      }
      // Template fields follow their layers into the new comp.
      if (c.template) {
        const moving = c.template.fields.filter((f) => ids.has(f.layerId));
        if (moving.length) child.template = { fields: moving };
        c.template.fields = c.template.fields.filter((f) => !ids.has(f.layerId));
        if (!c.template.fields.length) delete c.template;
      }
      p.compositions.push(child);
      const pre = makeLayer("precomp", c, { compId: child.id, name: child.name }) as PrecompLayer;
      if (cmd.newLayerId) pre.id = cmd.newLayerId;
      c.layers.splice(Math.min(firstIdx, c.layers.length), 0, pre);
      return { compId: child.id, layerId: pre.id };
    }
    case "asset.add":
      if (p.assets.some((a) => a.id === cmd.asset.id)) throw new CommandError("Asset id exists");
      p.assets.push(cmd.asset);
      return { assetId: cmd.asset.id };
    case "asset.remove": {
      const used = p.compositions.some((c) =>
        c.layers.some((l) => "assetId" in l && l.assetId === cmd.assetId),
      );
      if (used) throw new CommandError("Asset is used by a layer");
      p.assets = p.assets.filter((a) => a.id !== cmd.assetId);
      return;
    }
    default: {
      const t: never = cmd;
      throw new CommandError(`Unknown command: ${(t as { type: string }).type}`);
    }
  }
}

function validateCompNumbers(c: Composition) {
  if (!(c.fps > 0 && c.fps <= 240)) throw new CommandError("fps must be between 1 and 240");
  if (!(c.duration > 0 && c.duration <= 3600)) throw new CommandError("duration must be between 0 and 3600 seconds");
  if (!(c.width >= 16 && c.height >= 16 && c.width <= 8192 && c.height <= 8192))
    throw new CommandError("size must be between 16 and 8192 px");
}

/** Short human label for history and the audit log. */
export function describeCommand(cmd: Command): string {
  switch (cmd.type) {
    case "layer.add":
      return `Add ${cmd.layer?.type ?? cmd.layerType} layer`;
    case "layer.delete":
      return cmd.layerIds.length > 1 ? `Delete ${cmd.layerIds.length} layers` : "Delete layer";
    case "prop.set":
      return `Set ${cmd.path}`;
    case "prop.setKeyframes":
      return `Keyframe ${cmd.path}`;
    case "keyframe.setEase":
      return `Ease ${cmd.path}`;
    default:
      return cmd.type.replace(".", " ");
  }
}
