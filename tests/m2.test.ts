import { describe, expect, it } from "vitest";
import { Editor, evaluateComposition, makeProject, parseProject, serializeProject, type Vec2 } from "../src/core";
import { compileToHyperFrames } from "../src/compiler/hyperframes";
import { sceneToVNodes } from "../src/render/renderer";
import type { VNode } from "../src/render/vdom";
import { ffmpegArgs } from "../scripts/lib/node-export";

const measure = (s: string, _font: string) => s.length * 40;
const add = (ed: Editor, layerType: any, opts: any = {}, compId?: string) =>
  (ed.must({ type: "layer.add", layerType, opts, compId })[0] as { layerId: string }).layerId;
const walk = (nodes: VNode[], fn: (n: VNode) => void) =>
  nodes.forEach((n) => {
    fn(n);
    if (n.children) walk(n.children, fn);
  });
const tags = (nodes: VNode[]) => {
  const out: string[] = [];
  walk(nodes, (n) => out.push(n.tag));
  return out;
};

describe("effects (ED-11)", () => {
  it("adds, animates, reorders, toggles and removes effects with undo", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "shape");
    const fx = (ed.must({ type: "effect.add", layerId: id, kind: "blur" })[0] as { effectId: string }).effectId;
    ed.must({ type: "effect.add", layerId: id, kind: "dropShadow", id: "fx_shadow" });
    ed.must({ type: "prop.setKeyframes", layerId: id, path: `effects.${fx}.amount`, keyframes: [{ t: 0, v: 0 }, { t: 1, v: 20 }] });
    const comp = () => ed.project.compositions[0];
    const at = (t: number) => evaluateComposition(ed.project, comp(), t).layers[0].effects;
    expect(at(0.5)[0]).toMatchObject({ kind: "blur", amount: 10 });
    ed.must({ type: "effect.update", layerId: id, effectId: "fx_shadow", toIndex: 0 });
    expect(at(0).map((e) => e.kind)).toEqual(["dropShadow", "blur"]);
    ed.must({ type: "effect.update", layerId: id, effectId: fx, enabled: false });
    expect(at(0).map((e) => e.kind)).toEqual(["dropShadow"]);
    ed.must({ type: "effect.remove", layerId: id, effectId: "fx_shadow" });
    expect(comp().layers[0].effects).toHaveLength(1);
    ed.undo();
    expect(comp().layers[0].effects).toHaveLength(2);
    expect(() => ed.must({ type: "effect.add", layerId: id, kind: "sparkle" as never })).toThrow();
  });

  it("renders every effect as an SVG filter chain, and gradient overlays as a masked rect", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "shape");
    for (const kind of ["blur", "glow", "dropShadow", "colorCorrect", "gradientOverlay"] as const) ed.must({ type: "effect.add", layerId: id, kind, id: `fx_${kind}` });
    ed.must({ type: "prop.set", layerId: id, path: "effects.fx_colorCorrect.saturation", value: -50 });
    const scene = evaluateComposition(ed.project, ed.project.compositions[0], 0);
    const { defs, body } = sceneToVNodes(scene, measure);
    const all = tags([...defs, ...body]);
    expect(all).toContain("filter");
    expect(all).toContain("feGaussianBlur");
    expect(all).toContain("feColorMatrix");
    expect(all).toContain("feComponentTransfer");
    expect(all).toContain("feMerge");
    expect(all).toContain("linearGradient");
    let filtered = 0;
    walk(body, (n) => n.attrs.filter && filtered++);
    expect(filtered).toBe(1);
  });

  it("old files without effects still load", () => {
    const p = makeProject();
    const ed = new Editor(p);
    add(ed, "solid");
    const raw = JSON.parse(serializeProject(ed.project));
    delete raw.compositions[0].layers[0].effects;
    expect(parseProject(JSON.stringify(raw)).compositions[0].layers[0].effects).toEqual([]);
  });
});

describe("nested compositions (ED-02)", () => {
  function setup() {
    const ed = new Editor(makeProject());
    const main = ed.project.compositions[0].id;
    ed.must({ type: "comp.create", comp: { id: "comp_child", name: "Badge", width: 400, height: 200, duration: 4 }, activate: false });
    const inner = add(ed, "shape", { position: [200, 100] }, "comp_child");
    ed.must({ type: "prop.setKeyframes", compId: "comp_child", layerId: inner, path: "transform.opacity", keyframes: [{ t: 0, v: 0 }, { t: 2, v: 100 }] });
    const pre = add(ed, "precomp", { compId: "comp_child", position: [960, 540] }, main);
    return { ed, main, inner, pre };
  }

  it("evaluates the child at layer-local time, with offset and ids prefixed", () => {
    const { ed, main, inner, pre } = setup();
    ed.must({ type: "layer.update", layerId: pre, patch: { inPoint: 1, timeOffset: 0.5 } });
    const mainComp = ed.project.compositions.find((c) => c.id === main)!;
    const L = (t: number) => evaluateComposition(ed.project, mainComp, t).layers[0];
    const pl = L(2); // child time = 2 - 1 + 0.5 = 1.5 -> opacity 0.75
    expect(pl.content.type).toBe("precomp");
    const sc = (pl.content as { scene: { layers: { id: string; opacity: number }[] } }).scene;
    expect(sc.layers[0].id).toBe(`${pre}__${inner}`);
    expect(sc.layers[0].opacity).toBeCloseTo(0.75, 3);
    expect(mainComp.layers[0].transform.anchor.value).toEqual([200, 100] as Vec2);
    expect(mainComp.layers[0].name).toBe("Badge");
  });

  it("refuses loops and deleting a comp that is in use", () => {
    const { ed, main } = setup();
    expect(() => ed.must({ type: "layer.add", compId: "comp_child", layerType: "precomp", opts: { compId: main } })).toThrow(/loop/);
    expect(() => ed.must({ type: "layer.add", compId: main, layerType: "precomp", opts: { compId: main } })).toThrow(/loop/);
    expect(() => ed.must({ type: "comp.delete", compId: "comp_child" })).toThrow(/nested/);
    expect(() => ed.must({ type: "layer.add", layerType: "precomp", opts: { compId: "comp_nope" } })).toThrow(/not found/);
  });

  it("precompose moves layers into a new comp and keeps links inside it", () => {
    const ed = new Editor(makeProject());
    const a = add(ed, "shape");
    const b = add(ed, "text");
    const c = add(ed, "solid");
    ed.must({ type: "layer.update", layerId: a, patch: { parentId: b } });
    ed.must({ type: "layer.update", layerId: c, patch: { matte: { layerId: a, mode: "alpha" } } });
    const r = ed.must({ type: "comp.precompose", layerIds: [a, b], name: "Group" })[0] as { compId: string; layerId: string };
    const main = ed.project.compositions[0];
    const child = ed.project.compositions.find((x) => x.id === r.compId)!;
    expect(main.layers.map((l) => l.id)).toEqual([c, r.layerId]); // new layers go on top, so c sits above
    expect(main.layers[0].matte).toBeNull();
    expect(child.layers.map((l) => l.id).sort()).toEqual([a, b].sort());
    expect(child.layers.find((l) => l.id === a)!.parentId).toBe(b);
    ed.undo();
    expect(ed.project.compositions).toHaveLength(1);
    expect(ed.project.compositions[0].layers).toHaveLength(3);
  });

  it("compiles nested comps into the export and renders them clipped", () => {
    const { ed } = setup();
    const out = compileToHyperFrames(ed.project, { runtimeJs: "" });
    expect(out.html).toContain("comp_child");
    const mainComp = ed.project.compositions[0];
    const { defs } = sceneToVNodes(evaluateComposition(ed.project, mainComp, 1), measure);
    expect(tags(defs)).toContain("clipPath");
  });
});

describe("export formats (ED-20)", () => {
  it("WebM keeps alpha and GIF builds a transparent palette", () => {
    const webm = ffmpegArgs("webm", 30, "o.webm").join(" ");
    expect(webm).toContain("libvpx-vp9");
    expect(webm).toContain("yuva420p");
    expect(webm).toContain("-auto-alt-ref 0");
    const gif = ffmpegArgs("gif", 15, "o.gif").join(" ");
    expect(gif).toContain("palettegen=reserve_transparent=1");
    expect(gif).toContain("paletteuse");
  });
});
