import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("video and audio layers (ED-14, ED-23)", () => {
  it("video layers export from stills; audio mixes with offset, trim and volume", async () => {
    const { muxArgs } = await import("../scripts/lib/node-export");
    const ed = new Editor(makeProject());
    ed.must({ type: "asset.add", asset: { id: "asset_v", name: "v.mov", kind: "video", src: "assets/v.mov", width: 640, height: 360 } });
    ed.must({ type: "asset.add", asset: { id: "asset_r", name: "r.mov", kind: "video", src: "assets/r.mov", width: 640, height: 360 } });
    const v = add(ed, "video", { assetId: "asset_v" });
    const r = add(ed, "video", { assetId: "asset_r" });
    ed.must({ type: "layer.setVideoRole", layerId: r, role: "reference" });
    ed.must({ type: "layer.update", layerId: v, patch: { inPoint: 1, mediaOffset: 0.5 } });
    const out = compileToHyperFrames(ed.project, { runtimeJs: "", videoFrames: { asset_v: { pattern: "file:///s/%05d.png", fps: 30, count: 100 } } });
    expect(out.html).not.toContain("asset_r");
    expect(out.assets.map((a) => a.id)).toEqual([]); // stills replace the copy
    const p = structuredClone(ed.project);
    p.assets[0].frames = { pattern: "file:///s/%05d.png", fps: 30, count: 100 };
    const L = evaluateComposition(p, p.compositions[0], 2).layers.find((l) => l.id === v)!;
    expect((L.content as { frameSrc: string }).frameSrc).toBe("file:///s/00046.png"); // 1.5 s into the media -> frame 45 (1-based 46)
    const args = muxArgs("in.mov", [{ file: "a.wav", start: 0.5, offset: 2, duration: 3, volume: 0.8 }], 10, "prores4444", "out.mov").join(" ");
    expect(args).toContain("atrim=start=2.0000:duration=3.0000");
    expect(args).toContain("adelay=500:all=1");
    expect(args).toContain("volume=0.800");
    expect(args).toContain("pcm_s24le");
    expect(() => ed.must({ type: "layer.add", layerType: "audio", opts: { assetId: "nope" } })).toThrow(/Asset not found/);
  });

  // Runs FFmpeg for real: a split video's two sound halves start at different times.
  it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)("audio layers starting at different times keep their place in the mix", async () => {
    const { muxArgs } = await import("../scripts/lib/node-export");
    const dir = mkdtempSync(join(tmpdir(), "mge-mix-"));
    const f = (n: string) => join(dir, n);
    const ff = (...a: string[]) => expect(spawnSync("ffmpeg", ["-v", "error", "-y", ...a]).status).toBe(0);
    ff("-f", "lavfi", "-i", "color=black:s=64x64:d=4:r=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("v.mp4"));
    ff("-f", "lavfi", "-i", "sine=frequency=440:duration=4", f("tone.wav"));
    // second half (starts at 2.5 s) listed first, as a split puts it above the first half
    const halves = [
      { file: f("tone.wav"), start: 2.5, offset: 1.5, duration: 1.5, volume: 1 },
      { file: f("tone.wav"), start: 1, offset: 0, duration: 1.5, volume: 1 },
    ];
    expect(spawnSync("ffmpeg", muxArgs(f("v.mp4"), halves, 4, "mp4", f("out.mp4"))).status).toBe(0);
    const loud = (from: number) => {
      const r = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(from), "-t", "0.4", "-i", f("out.mp4"), "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
      return Number(/mean_volume: (-?[\d.]+)/.exec(r.stderr)?.[1] ?? -999);
    };
    const audioStart = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=start_time", "-of", "csv=p=0", f("out.mp4")], { encoding: "utf8" }).stdout.trim();
    expect(Number(audioStart)).toBeLessThan(0.1);
    expect(loud(0.3)).toBeLessThan(-60); // silent before the first half
    expect(loud(1.3)).toBeGreaterThan(-30); // first half
    expect(loud(3.0)).toBeGreaterThan(-30); // second half
    rmSync(dir, { recursive: true, force: true });
  });
});
