import { newId } from "./id";
import type {
  Composition,
  Geometry,
  ImageLayer,
  Layer,
  LayerType,
  NullLayer,
  OffsetPath,
  Repeater,
  PrecompLayer,
  Effect,
  EffectKind,
  Paint,
  Project,
  Prop,
  ReferenceVideoLayer,
  ShapeLayer,
  SolidLayer,
  TextLayer,
  Transform,
  Vec2,
  AnimValue,
} from "./types";
import { PROJECT_FORMAT, PROJECT_FORMAT_VERSION } from "./types";

export const COMP_PRESETS = {
  "HD 1080p": { width: 1920, height: 1080 },
  "HD 720p": { width: 1280, height: 720 },
  "4K UHD": { width: 3840, height: 2160 },
  "Vertical 9:16": { width: 1080, height: 1920 },
  "Square 1:1": { width: 1080, height: 1080 },
  "Portrait 4:5": { width: 1080, height: 1350 },
} as const;
export type CompPresetName = keyof typeof COMP_PRESETS;
export const FPS_PRESETS = [24, 25, 30, 60] as const;

export const prop = <T extends AnimValue>(value: T): Prop<T> => ({ value });

export function makeTransform(position: Vec2, anchor: Vec2 = [0, 0]): Transform {
  return {
    anchor: prop(anchor),
    position: prop(position),
    scale: prop<Vec2>([100, 100]),
    rotation: prop(0),
    opacity: prop(100),
  };
}

export function makeComposition(opts: Partial<Omit<Composition, "layers" | "markers">> = {}): Composition {
  return {
    id: opts.id ?? newId("comp"),
    name: opts.name ?? "Main",
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    fps: opts.fps ?? 30,
    duration: opts.duration ?? 15,
    background: opts.background ?? null,
    layers: [],
    markers: [],
  };
}

export function makeProject(name = "Untitled"): Project {
  const comp = makeComposition();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_FORMAT_VERSION,
    id: newId("proj"),
    name,
    compositions: [comp],
    assets: [],
    activeCompId: comp.id,
    settings: { permissionMode: "ask" },
  };
}

const solidPaint = (c: string): Paint => ({ kind: "solid", color: prop(c) });

interface LayerOpts {
  name?: string;
  position?: Vec2;
  inPoint?: number;
  outPoint?: number;
}

function common(comp: Pick<Composition, "width" | "height" | "duration">, o: LayerOpts, defName: string, anchor: Vec2 = [0, 0]) {
  return {
    id: newId("layer"),
    name: o.name ?? defName,
    parentId: null,
    inPoint: o.inPoint ?? 0,
    outPoint: o.outPoint ?? comp.duration,
    visible: true,
    locked: false,
    blendMode: "normal" as const,
    transform: makeTransform(o.position ?? [comp.width / 2, comp.height / 2], anchor),
    masks: [],
    matte: null,
    effects: [],
  };
}

export function makeGeometry(kind: Geometry["kind"], size: Vec2 = [400, 200]): Geometry {
  if (kind === "rect") return { id: newId("geo"), kind, position: prop<Vec2>([0, 0]), size: prop(size), roundness: prop(0) };
  if (kind === "ellipse") return { id: newId("geo"), kind, position: prop<Vec2>([0, 0]), size: prop(size) };
  return { id: newId("geo"), kind, path: prop({ closed: false, points: [] }) };
}

export interface MakeLayerOpts extends LayerOpts {
  color?: string;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  shape?: Geometry["kind"];
  size?: Vec2;
  assetId?: string;
  /** precomp: the nested composition id. */
  compId?: string;
  width?: number;
  height?: number;
}

export function makeLayer(type: LayerType, comp: Pick<Composition, "width" | "height" | "duration">, o: MakeLayerOpts = {}): Layer {
  switch (type) {
    case "solid": {
      const w = o.width ?? comp.width;
      const h = o.height ?? comp.height;
      const l: SolidLayer = { ...common(comp, o, "Solid", [w / 2, h / 2]), type, color: prop(o.color ?? "#3b82f6"), width: w, height: h };
      return l;
    }
    case "shape": {
      const l: ShapeLayer = {
        ...common(comp, o, "Shape"),
        type,
        geometry: [makeGeometry(o.shape ?? "rect", o.size ?? [400, 200])],
        combine: "merge",
        fill: { enabled: true, paint: solidPaint(o.color ?? "#f97316"), opacity: prop(100) },
        stroke: {
          enabled: false,
          paint: solidPaint("#ffffff"),
          width: prop(4),
          opacity: prop(100),
          lineCap: "round",
          lineJoin: "round",
        },
        trim: { enabled: false, start: prop(0), end: prop(100), offset: prop(0) },
      };
      return l;
    }
    case "text": {
      const l: TextLayer = {
        ...common(comp, o, o.text ? o.text.slice(0, 24) : "Text"),
        type,
        text: o.text ?? "Title",
        style: {
          family: o.fontFamily ?? "Inter, Helvetica Neue, Arial, sans-serif",
          weight: o.fontWeight ?? 700,
          italic: false,
          size: prop(o.fontSize ?? 96),
          tracking: prop(0),
          lineHeight: 1.2,
          align: "center",
          fill: prop(o.color ?? "#ffffff"),
        },
        animators: [],
      };
      return l;
    }
    case "image": {
      const l: ImageLayer = { ...common(comp, o, "Image", [(o.width ?? 0) / 2, (o.height ?? 0) / 2]), type, assetId: o.assetId ?? "" };
      return l;
    }
    case "reference": {
      const l: ReferenceVideoLayer = {
        ...common(comp, o, "Reference video", [(o.width ?? comp.width) / 2, (o.height ?? comp.height) / 2]),
        type,
        assetId: o.assetId ?? "",
        mediaOffset: 0,
        locked: true,
      };
      return l;
    }
    case "precomp": {
      const w = o.width ?? comp.width;
      const h = o.height ?? comp.height;
      const l: PrecompLayer = { ...common(comp, o, "Nested comp", [w / 2, h / 2]), type, compId: o.compId ?? "", timeOffset: 0 };
      return l;
    }
    case "null": {
      const l: NullLayer = { ...common(comp, o, "Null"), type };
      return l;
    }
  }
}

/** Repeater defaults (ED-09): three copies in a row, 100 px apart. */
export function makeRepeater(): Repeater {
  return {
    enabled: true,
    copies: prop(3),
    offset: prop(0),
    anchor: prop<Vec2>([0, 0]),
    position: prop<Vec2>([100, 0]),
    scale: prop<Vec2>([100, 100]),
    rotation: prop(0),
    startOpacity: prop(100),
    endOpacity: prop(100),
  };
}
export function makeOffsetPath(): OffsetPath {
  return { enabled: true, amount: prop(10), join: "round" };
}

/** A new effect with sensible defaults (ED-11). */
export function makeEffect(kind: EffectKind, id = newId("fx")): Effect {
  switch (kind) {
    case "blur":
      return { id, kind, enabled: true, amount: prop(10) };
    case "glow":
      return { id, kind, enabled: true, radius: prop(24), intensity: prop(100), color: prop("#ffffff") };
    case "dropShadow":
      return { id, kind, enabled: true, color: prop("#000000"), opacity: prop(60), distance: prop(8), angle: prop(90), softness: prop(16) };
    case "colorCorrect":
      return { id, kind, enabled: true, brightness: prop(0), contrast: prop(0), saturation: prop(0), hue: prop(0) };
    case "gradientOverlay":
      return {
        id,
        kind,
        enabled: true,
        gradient: "linear",
        stops: [
          { offset: 0, color: prop("#f97316") },
          { offset: 1, color: prop("#ec4899") },
        ],
        start: prop<Vec2>([-300, 0]),
        end: prop<Vec2>([300, 0]),
        opacity: prop(100),
      };
  }
}
