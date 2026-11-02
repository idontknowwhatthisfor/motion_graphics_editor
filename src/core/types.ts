/**
 * Project format v1: the single source of truth.
 *
 * Rules that everything else relies on:
 * - All times are in SECONDS (composition time), never frames. Changing a
 *   composition's fps therefore never moves a keyframe (ED-24).
 * - Layers are ordered top-first: layers[0] is drawn on top.
 * - Every object that can be referenced has a stable string `id`.
 * - The format is plain JSON (no class instances, no functions) so it can be
 *   diffed, autosaved, sent over MCP and compiled to HTML.
 */

export const PROJECT_FORMAT = "mge-project";
export const PROJECT_FORMAT_VERSION = 1;

export type Vec2 = [number, number];
/** CSS hex colour, `#rrggbb` or `#rrggbbaa`. */
export type Color = string;

/** A point on a bezier path. `in` / `out` are tangents relative to `p`. */
export interface PathPoint {
  p: Vec2;
  in: Vec2;
  out: Vec2;
}
export interface PathData {
  closed: boolean;
  points: PathPoint[];
}

export type AnimValue = number | Vec2 | Color | PathData;

/** Easing applied from a keyframe to the NEXT keyframe. */
export type Ease =
  | { kind: "linear" }
  | { kind: "hold" }
  /** CSS-style cubic-bezier: x1,x2 in [0,1], y may overshoot. */
  | { kind: "bezier"; x1: number; y1: number; x2: number; y2: number };

export interface Keyframe<T extends AnimValue = AnimValue> {
  id: string;
  /** Composition time in seconds. */
  t: number;
  v: T;
  /** Easing from this keyframe to the next one. */
  ease: Ease;
  /** Spatial tangents for Vec2 properties (motion paths), relative to v. */
  spatialIn?: Vec2;
  spatialOut?: Vec2;
}

/**
 * An animatable property. When `keyframes` is non-empty the property is
 * animated and `value` is ignored at render time (it is kept as the value to
 * fall back to if all keyframes are removed).
 */
export interface Prop<T extends AnimValue = AnimValue> {
  value: T;
  keyframes?: Keyframe<T>[];
}

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export interface Transform {
  /** Layer-space point that position/rotation/scale pivot around. */
  anchor: Prop<Vec2>;
  /** Position of the anchor in parent (or composition) space, in px. */
  position: Prop<Vec2>;
  /** Percent, [100, 100] = unscaled. */
  scale: Prop<Vec2>;
  /** Degrees, clockwise. */
  rotation: Prop<number>;
  /** 0–100. */
  opacity: Prop<number>;
}

export type MaskMode = "add" | "subtract" | "intersect";
export interface Mask {
  id: string;
  name: string;
  mode: MaskMode;
  inverted: boolean;
  path: Prop<PathData>;
  /** 0–100 */
  opacity: Prop<number>;
  /** px */
  feather: Prop<number>;
}

export type MatteMode = "alpha" | "alphaInverted" | "luma" | "lumaInverted";
export interface TrackMatte {
  /** Id of the layer (in the same composition) used as the matte. */
  layerId: string;
  mode: MatteMode;
}

export interface GradientStop {
  /** 0–1 */
  offset: number;
  color: Prop<Color>;
}
export type Paint =
  | { kind: "solid"; color: Prop<Color> }
  | {
      kind: "linear" | "radial";
      stops: GradientStop[];
      /** Layer-space points. Radial: start = centre, end = a point on the edge. */
      start: Prop<Vec2>;
      end: Prop<Vec2>;
    };

export type Geometry =
  | { id: string; kind: "rect"; position: Prop<Vec2>; size: Prop<Vec2>; roundness: Prop<number> }
  | { id: string; kind: "ellipse"; position: Prop<Vec2>; size: Prop<Vec2> }
  | { id: string; kind: "path"; path: Prop<PathData> };

/** How a shape layer's geometries combine (boolean operations, ED-08). */
export type CombineMode = "merge" | "subtract" | "intersect" | "exclude";

export interface Fill {
  enabled: boolean;
  paint: Paint;
  opacity: Prop<number>;
}
export interface Stroke {
  enabled: boolean;
  paint: Paint;
  width: Prop<number>;
  opacity: Prop<number>;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
}
/** Trim paths (ED-08). Percentages 0–100, offset in degrees. */
export interface TrimPaths {
  enabled: boolean;
  start: Prop<number>;
  end: Prop<number>;
  offset: Prop<number>;
}

export type SelectorShape = "square" | "rampUp" | "rampDown" | "triangle" | "smooth";
export interface TextAnimator {
  id: string;
  name: string;
  selector: {
    basedOn: "characters" | "words";
    shape: SelectorShape;
    /** 0–100 % of units */
    start: Prop<number>;
    end: Prop<number>;
    offset: Prop<number>;
    /** 0–100: smoothness of ramps. */
    ease?: number;
  };
  /**
   * Values applied fully to selected characters (AE-style "animator
   * properties"): offsets added to the character's resting state.
   */
  props: {
    opacity?: Prop<number>; // target opacity 0–100 for fully selected chars
    position?: Prop<Vec2>; // offset px
    scale?: Prop<Vec2>; // percent
    rotation?: Prop<number>; // degrees
    fillColor?: Prop<Color>;
    blur?: Prop<number>; // px
  };
}

export interface TextStyle {
  family: string;
  weight: number;
  italic: boolean;
  size: Prop<number>;
  /** Extra spacing between characters in px. */
  tracking: Prop<number>;
  /** Line height multiplier. */
  lineHeight: number;
  align: "left" | "center" | "right";
  fill: Prop<Color>;
  stroke?: { color: Prop<Color>; width: Prop<number> };
}

interface LayerCommon {
  id: string;
  name: string;
  parentId: string | null;
  /** Seconds; the layer is visible over [inPoint, outPoint). */
  inPoint: number;
  outPoint: number;
  visible: boolean;
  locked: boolean;
  blendMode: BlendMode;
  transform: Transform;
  masks: Mask[];
  matte: TrackMatte | null;
  /** UI colour label. */
  label?: string;
}

export interface SolidLayer extends LayerCommon {
  type: "solid";
  color: Prop<Color>;
  width: number;
  height: number;
}
export interface ShapeLayer extends LayerCommon {
  type: "shape";
  geometry: Geometry[];
  combine: CombineMode;
  fill: Fill;
  stroke: Stroke;
  trim: TrimPaths;
}
export interface TextLayer extends LayerCommon {
  type: "text";
  text: string;
  style: TextStyle;
  animators: TextAnimator[];
}
export interface ImageLayer extends LayerCommon {
  type: "image";
  assetId: string;
}
export interface NullLayer extends LayerCommon {
  type: "null";
}
/** Reference video (ED-17): shown in the editor, never exported. */
export interface ReferenceVideoLayer extends LayerCommon {
  type: "reference";
  assetId: string;
  /** Seconds into the media at the layer's inPoint. */
  mediaOffset: number;
}

export type Layer =
  | SolidLayer
  | ShapeLayer
  | TextLayer
  | ImageLayer
  | NullLayer
  | ReferenceVideoLayer;
export type LayerType = Layer["type"];

export interface Marker {
  id: string;
  t: number;
  label: string;
  color?: Color;
}

export interface Composition {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  /** Seconds. */
  duration: number;
  /** null = transparent (the default, for overlays). */
  background: Color | null;
  layers: Layer[];
  markers: Marker[];
}

export interface Asset {
  id: string;
  name: string;
  kind: "image" | "svg" | "video";
  /** Path relative to the project folder (`assets/x.png`) or a data: URL. */
  src: string;
  width: number;
  height: number;
  duration?: number;
}

export type PermissionMode = "readOnly" | "ask" | "autoKeep";

export interface Project {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_FORMAT_VERSION;
  id: string;
  name: string;
  compositions: Composition[];
  assets: Asset[];
  activeCompId: string;
  settings: {
    /** How Claude's change sets are handled (Permission and privacy). */
    permissionMode: PermissionMode;
  };
}
