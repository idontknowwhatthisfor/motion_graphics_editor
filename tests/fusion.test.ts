/**
 * Fusion export (src/compiler/fusion.ts). The generated Lua is parsed back
 * with a small reader below, and a tiny model of Fusion's nodes (splines,
 * XYPath, Transform, masks) is checked against our own evaluator: where the
 * Fusion comp puts a shape's corners must match where the editor draws them.
 * If DaVinci Resolve is installed, its own fuscript parses the files too.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileToFusion, fontStyle, luaString, writeLua } from "../src/compiler/fusion";
import { Editor, makeProject, type Layer, type Project, type ShapeLayer, type Vec2 } from "../src/core";
import { evaluateComposition } from "../src/core/evaluate";
import { apply } from "../src/core/geometry";
import { lowerThirdProject } from "../src/core/samples";
import { easePreset } from "../src/core/easing";
import { valueAt } from "../src/core/interpolate";

// ---------------------------------------------------------------- Lua reader
type V = number | string | boolean | T;
interface T {
  ctor?: string;
  map: Record<string, V>;
  arr: V[];
}
function readLua(src: string): V {
  let i = 0;
  const ws = () => {
    while (i < src.length) {
      if (/\s/.test(src[i])) i++;
      else if (src.startsWith("--", i)) while (i < src.length && src[i] !== "\n") i++;
      else break;
    }
  };
  const peek = () => (ws(), src[i]);
  const expect_ = (c: string) => {
    ws();
    if (src[i] !== c) throw new Error(`expected ${c} at ${i}: ${src.slice(i, i + 40)}`);
    i++;
  };
  const ident = () => {
    ws();
    const m = /^[A-Za-z_][A-Za-z0-9_.]*(\(\))?/.exec(src.slice(i));
    if (!m) throw new Error(`identifier expected at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const str = (): string => {
    expect_('"');
    let s = "";
    while (src[i] !== '"') {
      if (src[i] === "\\") {
        i++;
        const c = src[i];
        if (/\d/.test(c)) {
          s += String.fromCharCode(Number(src.slice(i, i + 3)));
          i += 3;
          continue;
        }
        s += c === "n" ? "\n" : c === "t" ? "\t" : c;
      } else s += src[i];
      i++;
    }
    i++;
    return s;
  };
  const value = (): V => {
    const c = peek();
    if (c === "{") return table();
    if (c === '"') return str();
    const m = /^-?\d+(\.\d+)?(e-?\d+)?/i.exec(src.slice(i));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    const id = ident();
    if (id === "true" || id === "false") return id === "true";
    const t = table();
    t.ctor = id;
    return t;
  };
  const table = (): T => {
    expect_("{");
    const t: T = { map: {}, arr: [] };
    while (peek() !== "}") {
      if (src[i] === "[") {
        i++;
        const k = peek() === '"' ? str() : (value() as number);
        expect_("]");
        expect_("=");
        t.map[String(k)] = value();
      } else {
        const save = i;
        const m = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(src.slice(i));
        if (m) {
          i += m[0].length;
          t.map[m[0].replace(/\s*=$/, "")] = value();
        } else {
          i = save;
          t.arr.push(value());
        }
      }
      if (peek() === ",") i++;
    }
    expect_("}");
    return t;
  };
  const v = value();
  ws();
  if (i !== src.length) throw new Error(`trailing text at ${i}`);
  return v;
}

// ----------------------------------------------------- model of Fusion nodes
class FusionModel {
  tools: Record<string, T>;
  constructor(
    public root: T,
    public W: number,
    public H: number,
  ) {
    this.tools = (root.map.Tools as T).map as Record<string, T>;
  }
  tool(n: string) {
    const t = this.tools[n];
    if (!t) throw new Error(`no tool ${n}`);
    return t;
  }
  inputs(n: string) {
    return (this.tool(n).map.Inputs as T).map as Record<string, T>;
  }
  /** Value of an input at frame f (follows splines and XY paths). */
  input(n: string, input: string, f: number): number | number[] | string {
    const inp = this.inputs(n)[input];
    if (!inp) throw new Error(`${n}.${input} missing`);
    if ("Value" in inp.map) {
      const v = inp.map.Value as V;
      return typeof v === "object" ? (v.arr as number[]) : (v as number);
    }
    const src = inp.map.SourceOp as string;
    const t = this.tool(src);
    if (t.ctor === "BezierSpline") return evalSpline(t.map.KeyFrames as T, f);
    if (t.ctor === "XYPath") return [this.input(src, "X", f) as number, this.input(src, "Y", f) as number];
    throw new Error(`unknown modifier ${t.ctor}`);
  }
  link(n: string, input: string): string | null {
    const inp = this.inputs(n)[input];
    return inp && "SourceOp" in inp.map ? (inp.map.SourceOp as string) : null;
  }
  /** Fusion Transform on a pixel point (y down): p' = C + R·S·(p − Pivot) + Pivot − frame centre. */
  transform(n: string, p: Vec2, f: number): Vec2 {
    const C = this.input(n, "Center", f) as number[];
    const Pv = this.input(n, "Pivot", f) as number[];
    const sx = this.input(n, "XSize", f) as number;
    const sy = this.input(n, "YSize", f) as number;
    const ang = this.input(n, "Angle", f) as number;
    const c: Vec2 = [C[0] * this.W, (1 - C[1]) * this.H];
    const pv: Vec2 = [Pv[0] * this.W, (1 - Pv[1]) * this.H];
    const r = (-ang * Math.PI) / 180; // Fusion's counter-clockwise angle, as a y-down clockwise one
    const x = (p[0] - pv[0]) * sx;
    const y = (p[1] - pv[1]) * sy;
    return [c[0] + Math.cos(r) * x - Math.sin(r) * y + pv[0] - this.W / 2, c[1] + Math.sin(r) * x + Math.cos(r) * y + pv[1] - this.H / 2];
  }
  /** Follow Merge.Foreground through Transforms; returns the content node and transform names (inner first). */
  layerChain(merge: string): { content: string; transforms: string[] } {
    let n = this.link(merge, "Foreground")!;
    const transforms: string[] = [];
    while (this.tool(n).ctor === "Transform") {
      transforms.unshift(n);
      n = this.link(n, "Input")!;
    }
    return { content: n, transforms: transforms.reverse() };
  }
  /** Where a pixel of a layer's content lands in the final frame. */
  place(merge: string, p: Vec2, f: number): Vec2 {
    const { transforms } = this.layerChain(merge);
    // transforms[] is outer→inner after reverse; apply the inner (own) one first.
    return [...transforms].reverse().reduce((q, n) => this.transform(n, q, f), p);
  }
}
function evalSpline(k: T, f: number): number {
  const keys = Object.entries(k.map)
    .map(([fr, v]) => ({ f: Number(fr), v: (v as T).arr[0] as number, lh: (v as T).map.LH as T | undefined, rh: (v as T).map.RH as T | undefined }))
    .sort((a, b) => a.f - b.f);
  if (f <= keys[0].f) return keys[0].v;
  if (f >= keys[keys.length - 1].f) return keys[keys.length - 1].v;
  const j = keys.findIndex((x) => x.f > f);
  const a = keys[j - 1];
  const b = keys[j];
  const p1 = a.rh ? (a.rh.arr as number[]) : [a.f + (b.f - a.f) / 3, a.v + (b.v - a.v) / 3];
  const p2 = b.lh ? (b.lh.arr as number[]) : [a.f + (2 * (b.f - a.f)) / 3, a.v + (2 * (b.v - a.v)) / 3];
  const bz = (s: number, q0: number, q1: number, q2: number, q3: number) => (1 - s) ** 3 * q0 + 3 * (1 - s) ** 2 * s * q1 + 3 * (1 - s) * s * s * q2 + s ** 3 * q3;
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 60; it++) {
    const m = (lo + hi) / 2;
    if (bz(m, a.f, p1[0], p2[0], b.f) < f) lo = m;
    else hi = m;
  }
  return bz((lo + hi) / 2, a.v, p1[1], p2[1], b.v);
}

const OUT = "/tmp/mge-fusion-test";
function compile(p: Project, opts: { fps?: number; width?: number } = {}) {
  const r = compileToFusion(p, { outDir: OUT, ...opts });
  const comp = p.compositions.find((c) => c.id === p.activeCompId)!;
  return { r, m: new FusionModel(readLua(r.comp) as T, comp.width, comp.height), comp };
}
const mergeOf = (m: FusionModel, layerName: string) => {
  const n = Object.keys(m.tools).find((k) => k === `${layerName.replace(/[^A-Za-z0-9_]+/g, "_")}_Merge`);
  if (!n) throw new Error(`no merge for ${layerName}`);
  return n;
};
const near = (a: Vec2, b: Vec2, tol = 0.05) => {
  expect(a[0]).toBeCloseTo(b[0], 0);
  expect(Math.abs(a[0] - b[0])).toBeLessThan(tol);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(tol);
};
const add = (ed: Editor, layerType: string, opts: Record<string, unknown> = {}) => (ed.must({ type: "layer.add", layerType: layerType as never, opts })[0] as { layerId: string }).layerId;

/** Corners of a rect geometry as Fusion places them vs as the editor does. */
function checkRect(m: FusionModel, project: Project, comp: Project["compositions"][number], layer: Layer, fps: number, frames: number[]) {
  const merge = mergeOf(m, layer.name);
  const { content } = m.layerChain(merge);
  const mask = m.link(content, "EffectMask")!;
  for (const f of frames) {
    const t = f / fps;
    const C = m.input(mask, "Center", f) as number[];
    const w = (m.input(mask, "Width", f) as number) * m.W; // width units
    const h = (m.input(mask, "Height", f) as number) * m.W;
    const center: Vec2 = [C[0] * m.W, (1 - C[1]) * m.H];
    const g = (layer as { geometry: { position: { value: Vec2 }; size: { value: Vec2 } }[] }).geometry[0];
    // evaluateComposition applies expressions; worldMatrix alone would not.
    const M = evaluateComposition(project, comp, t).layers.find((x) => x.id === layer.id)!.matrix;
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const fusion = m.place(merge, [center[0] + (dx * w) / 2, center[1] + (dy * h) / 2], f);
      const ours = apply(M, [g.position.value[0] + (dx * g.size.value[0]) / 2, g.position.value[1] + (dy * g.size.value[1]) / 2]);
      near(fusion, ours, 0.05);
    }
  }
}

describe("Lua writer", () => {
  it("escapes strings and writes Fusion-style tables", () => {
    expect(luaString('a "b" \\ c\nd')).toBe('"a \\"b\\" \\\\ c\\nd"');
    expect(luaString("x\u0001")).toBe('"x\\001"');
    const out = writeLua({ ctor: "Input", entries: [["Value", { ctor: "FuID", entries: [[null, "Soft Light"]] }]] });
    expect(out.replace(/\s+/g, " ")).toBe('Input { Value = FuID { "Soft Light" }, }');
    expect(writeLua({ entries: [[12.5, 1], ["Gamut.SLogVersion", 2]] })).toBe('{ [12.5] = 1, ["Gamut.SLogVersion"] = 2 }');
  });
  it("maps font weights to Text+ style names", () => {
    expect(fontStyle(400, false)).toBe("Regular");
    expect(fontStyle(700, true)).toBe("Bold Italic");
    expect(fontStyle(400, true)).toBe("Italic");
    expect(fontStyle(540, false)).toBe("Medium");
  });
});

describe("Fusion export: the lower third", () => {
  const p = lowerThirdProject();
  const { r, m, comp } = compile(p);

  it("is a Composition with the expected nodes, frame range and MediaOut", () => {
    expect(m.root.ctor).toBe("Composition");
    expect((m.root.map.RenderRange as T).arr).toEqual([0, 179]);
    const kinds = Object.values(m.tools).map((t) => t.ctor);
    for (const k of ["Background", "RectangleMask", "Transform", "Merge", "TextPlus", "BezierSpline", "Loader", "MediaOut"]) expect(kinds).toContain(k);
    expect(m.link("MediaOut1", "Input")).toBe("Role_Merge"); // the top layer is merged last
    expect(r.frames).toBe(180);
    // The settings file is the same nodes for pasting, without MediaOut.
    const s = readLua(r.setting) as T;
    expect(s.map.ActiveTool).toBe("Role_Merge");
    expect(Object.keys((s.map.Tools as T).map)).not.toContain("MediaOut1");
  });

  it("flattens only the text with an animator, and says so", () => {
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].layerIds).toEqual([comp.layers.find((l) => l.name === "Name")!.id]);
    expect(r.notes.join("\n")).toMatch(/Name \(text\): rendered to PNG frames because of text animators/);
    const loader = m.tool(m.link("Name_Merge", "Foreground")!);
    expect(loader.ctor).toBe("Loader");
    const clip = (loader.map.Clips as T).arr[0] as T;
    expect(clip.map.Filename).toBe(`${OUT}/flattened/01-Name/frame_00000.png`);
    expect(clip.map.TrimOut).toBe(179);
  });

  it("keeps the role text editable as Text+", () => {
    const { content } = m.layerChain("Role_Merge");
    const inp = m.inputs(content);
    expect(inp.StyledText.map.Value).toBe("Motion Designer");
    expect(inp.Font.map.Value).toBe("Inter");
    expect(inp.Style.map.Value).toBe("Medium");
    expect(inp.Size.map.Value).toBeCloseTo(34 / 1920, 9);
    expect(inp.HorizontalLeftCenterRight.map.Value).toBe(-1);
  });

  it("puts the bar and accent where the editor draws them, frame by frame (parented to the null)", () => {
    for (const name of ["Bar", "Accent"]) checkRect(m, p, comp, comp.layers.find((l) => l.name === name)!, 30, [0, 6, 10, 15, 27, 90, 160, 170, 179]);
  });

  it("turns easing into spline handles and fades opacity with Blend", () => {
    const ed = new Editor(p);
    const role = ed.project.compositions[0].layers.find((l) => l.name === "Role")!;
    for (const f of [27, 30, 36, 40, 45, 150, 155, 159, 170]) {
      const ours = (valueAt(role.transform.opacity, f / 30) as number) / 100;
      expect(m.input("Role_Merge", "Blend", f) as number).toBeCloseTo(ours, 3);
    }
  });
});

describe("Fusion export: transforms, parenting, easing, holds", () => {
  const build = () => {
    const ed = new Editor(makeProject("T"));
    const parent = add(ed, "null", { name: "Rig", position: [700, 420] });
    const child = add(ed, "shape", { name: "Box", position: [120, 60], size: [200, 80] });
    const ease = easePreset("easeOutExpo");
    ed.must([
      { type: "layer.update", layerId: child, patch: { parentId: parent } },
      { type: "prop.set", layerId: child, path: "transform.anchor", value: [30, -10] },
      { type: "prop.set", layerId: child, path: "geometry.0.position", value: [40, 15] },
      { type: "prop.setKeyframes", layerId: parent, path: "transform.rotation", keyframes: [{ t: 0, v: 0, ease }, { t: 2, v: 90 }] },
      { type: "prop.setKeyframes", layerId: parent, path: "transform.scale", keyframes: [{ t: 0.5, v: [150, 60], ease: { kind: "hold" } }, { t: 1.5, v: [80, 120] }] },
      { type: "prop.setKeyframes", layerId: child, path: "transform.position", keyframes: [{ t: 0, v: [-300, 60], ease }, { t: 1, v: [120, 60], ease: { kind: "linear" } }, { t: 3, v: [160, 200] }] },
      { type: "prop.set", layerId: child, path: "transform.rotation", value: 30 },
      { type: "layer.update", layerId: child, patch: { inPoint: 0.5, outPoint: 3.5 } },
    ]);
    return { ed, parent, child };
  };

  it("matches the editor's world matrix with anchors, rotation, scale holds and a parent", () => {
    const { ed, child } = build();
    const { m, comp } = compile(ed.project);
    checkRect(m, ed.project, comp, comp.layers.find((l) => l.id === child)!, comp.fps, [15, 20, 29, 30, 31, 44, 45, 46, 60, 75, 89, 100]);
  });

  it("writes a hold as an extra key just before the next one", () => {
    const { ed } = build();
    const { r, m } = compile(ed.project);
    const xs = Object.entries(m.tools).find(([n]) => n === "Box_Transform_RigXSize")![1];
    const frames = Object.keys((xs.map.KeyFrames as T).map).map(Number).sort((a, b) => a - b);
    expect(frames).toEqual([15, 44.999, 45]);
    expect(r.comp).toContain("Flags = { Linear = true }");
  });

  it("hides a layer outside its in/out points", () => {
    const { ed } = build();
    const { m } = compile(ed.project);
    expect(m.input("Box_Merge", "Blend", 14)).toBe(0);
    expect(m.input("Box_Merge", "Blend", 15)).toBeCloseTo(1, 6);
    expect(m.input("Box_Merge", "Blend", 104)).toBeCloseTo(1, 6);
    expect(m.input("Box_Merge", "Blend", 105)).toBe(0);
  });

  it("keeps keyframe times in seconds when the export frame rate changes", () => {
    const { ed, child } = build();
    const { m, comp } = compile(ed.project, { fps: 60 });
    expect((m.root.map.RenderRange as T).arr).toEqual([0, comp.duration * 60 - 1]);
    checkRect(m, ed.project, comp, comp.layers.find((l) => l.id === child)!, 60, [30, 60, 90, 120, 179]);
  });

  it("bakes expressions and curved motion paths, and lists them", () => {
    const { ed, child, parent } = build();
    ed.must([
      { type: "prop.setExpression", layerId: parent, path: "transform.position", expression: "value + [time * 50, 0]" },
      { type: "keyframe.update", layerId: child, path: "transform.position", keyframeId: ed.project.compositions[0].layers.find((l) => l.id === child)!.transform.position.keyframes![1].id, patch: { spatialOut: [80, -120] } } as never,
    ]);
    const { r, m, comp } = compile(ed.project);
    expect(r.notes.join("\n")).toMatch(/Sampled once per frame.*Rig\.transform\.position/);
    checkRect(m, ed.project, comp, comp.layers.find((l) => l.id === child)!, comp.fps, [20, 33, 47, 61, 90]);
  });
});

describe("Fusion export: fallbacks and blend modes", () => {
  it("maps blend modes, groups neighbouring flattened layers and skips audio with a note", () => {
    const ed = new Editor(makeProject("F"));
    const a = add(ed, "shape", { name: "Glow box" });
    const b = add(ed, "shape", { name: "Stroked" });
    add(ed, "shape", { name: "Plain" });
    ed.must([
      { type: "effect.add", layerId: a, kind: "blur" } as never,
      { type: "layer.update", layerId: b, patch: { blendMode: "soft-light", stroke: { ...(ed.project.compositions[0].layers.find((l) => l.id === b) as ShapeLayer).stroke, enabled: true } } },
    ]);
    const { r, m } = compile(ed.project);
    // Layers stack top-first: Plain is on top, Stroked and Glow box sit together below it.
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].layerIds.sort()).toEqual([a, b].sort());
    expect(r.notes.join("\n")).toMatch(/Stroked \(shape\): rendered to PNG frames because of stroke/);
    expect(r.notes.join("\n")).toMatch(/Glow box \(shape\): rendered to PNG frames because of effects/);
    expect(r.notes.join("\n")).toMatch(/soft-light blend mode is rendered against transparency/);
    expect(m.link("MediaOut1", "Input")).toBe("Plain_Merge");
  });

  it("writes a native blend mode as a Merge ApplyMode", () => {
    const ed = new Editor(makeProject("B"));
    const s = add(ed, "shape", { name: "Screen me" });
    ed.must({ type: "layer.update", layerId: s, patch: { blendMode: "color-dodge" } });
    const { m } = compile(ed.project);
    expect(((m.inputs("Screen_me_Merge").ApplyMode.map.Value as T).arr)).toEqual(["Color Dodge"]);
  });
});

const FUSCRIPT = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fuscript";
describe.skipIf(!existsSync(FUSCRIPT))("Resolve's own parser (fuscript)", () => {
  it("reads the .comp and .setting files", () => {
    const role = 'He said "hi" \\ \nand left';
    const { r } = compile(lowerThirdProject("Name", role));
    const dir = mkdtempSync(join(tmpdir(), "mge-fusion-"));
    writeFileSync(join(dir, "a.comp"), r.comp);
    writeFileSync(join(dir, "a.setting"), r.setting);
    const lua = `local c = bmd.readfile([[${dir}/a.comp]]); local s = bmd.readfile([[${dir}/a.setting]]);
      local n = 0; for k, v in pairs(c.Tools) do if k ~= "__flags" then n = n + 1 end end
      print("OK " .. n .. " " .. c.RenderRange[2] .. " " .. s.ActiveTool .. " " .. c.Tools.MediaOut1.Inputs.Input.SourceOp
        .. " " .. c.Tools.Role_Text.Inputs.StyledText.Value:len())`;
    const out = execFileSync(FUSCRIPT, ["-l", "lua", "-x", lua], { encoding: "utf8", timeout: 20000 });
    const line = out.split("\n").find((l) => l.startsWith("OK"))!;
    expect(line).toBeTruthy();
    const [, n, end, active, media, textLen] = line.trim().split(/\s+/);
    expect(Number(textLen)).toBe(role.length); // quotes, backslash and newline came through intact
    expect(Number(n)).toBe(Object.keys(((readLua(r.comp) as T).map.Tools as T).map).length);
    expect(end).toBe("179");
    expect(active).toBe("Role_Merge");
    expect(media).toBe("Role_Merge");
  });
});
