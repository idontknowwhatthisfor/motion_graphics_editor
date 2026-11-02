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
  /**
   * Optional expression (ED-12, see core/expressions.ts). Applied on top of
   * the keyframed value at render time; `value` inside it is that value.
   */
  expression?: string;
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

/**
 * Layer effects (ED-11), applied in order after masks, as SVG filters (GPU
 * composited by Chrome). All sizes are composition pixels.
 */
export type Effect =
  | { id: string; kind: "blur"; enabled: boolean; amount: Prop<number> }
  | { id: string; kind: "glow"; enabled: boolean; radius: Prop<number>; intensity: Prop<number>; color: Prop<Color> }
  | {
      id: string;
      kind: "dropShadow";
      enabled: boolean;
      color: Prop<Color>;
      /** 0–100 */
      opacity: Prop<number>;
      distance: Prop<number>;
      /** Degrees, 90 = straight down. */
      angle: Prop<number>;
      softness: Prop<number>;
    }
  | {
      id: string;
      kind: "colorCorrect";
      enabled: boolean;
      /** -100..100 */
      brightness: Prop<number>;
      /** -100..100 */
      contrast: Prop<number>;
      /** -100..100 */
      saturation: Prop<number>;
      /** Degrees */
      hue: Prop<number>;
    }
  | {
      id: string;
      kind: "gradientOverlay";
      enabled: boolean;
      gradient: "linear" | "radial";
      stops: GradientStop[];
      /** Layer-space points. */
      start: Prop<Vec2>;
      end: Prop<Vec2>;
      /** 0–100 */
      opacity: Prop<number>;
    };
export type EffectKind = Effect["kind"];

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
  /** Effects stack (ED-11). Optional for files written before Milestone 2. */
  effects?: Effect[];
  /** UI colour label. */
  label?: string;
}

export interface SolidLayer extends LayerCommon {
  type: "solid";
  color: Prop<Color>;
  width: number;
  height: number;
}
/**
 * Repeater (ED-09): draws `copies` copies of the shape; copy k gets the
 * transform applied k times (k = index + offset), so position + rotation
 * makes rows, rings and spirals.
 */
export interface Repeater {
  enabled: boolean;
  copies: Prop<number>;
  offset: Prop<number>;
  anchor: Prop<Vec2>;
  position: Prop<Vec2>;
  scale: Prop<Vec2>;
  rotation: Prop<number>;
  /** 0–100, first and last copy; copies between are interpolated. */
  startOpacity: Prop<number>;
  endOpacity: Prop<number>;
}
/** Offset paths (ED-09): grow (+) or shrink (-) every geometry by `amount` px. */
export interface OffsetPath {
  enabled: boolean;
  amount: Prop<number>;
  join: "miter" | "round";
}

export interface ShapeLayer extends LayerCommon {
  type: "shape";
  geometry: Geometry[];
  combine: CombineMode;
  fill: Fill;
  stroke: Stroke;
  trim: TrimPaths;
  repeater?: Repeater;
  offsetPath?: OffsetPath;
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

/** Nested composition (ED-02). */
export interface PrecompLayer extends LayerCommon {
  type: "precomp";
  compId: string;
  /** Seconds into the nested comp at this layer's inPoint. */
  timeOffset: number;
}

export type Layer =
  | PrecompLayer
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
