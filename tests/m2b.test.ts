import { describe, expect, it } from "vitest";
import { Editor, checkExpression, evaluateComposition, makeProject, offsetPathD, type Layer, type ShapeLayer, type Vec2 } from "../src/core";
import { sceneToVNodes } from "../src/render/renderer";

const add = (ed: Editor, layerType: any, opts: any = {}) =>
  (ed.must({ type: "layer.add", layerType, opts })[0] as { layerId: string }).layerId;
const comp = (ed: Editor) => ed.project.compositions[0];
const scene = (ed: Editor, t: number) => evaluateComposition(ed.project, comp(ed), t);
const layerOf = (ed: Editor, id: string, t: number) => scene(ed, t).layers.find((l) => l.id === id)!;
const pos = (ed: Editor, id: string, t: number): Vec2 => [layerOf(ed, id, t).matrix[4], layerOf(ed, id, t).matrix[5]];
const opacity = (ed: Editor, id: string, t: number) => layerOf(ed, id, t).opacity;

describe("expressions (ED-12)", () => {
  it("does arithmetic on the keyframed value, with vectors and time", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "null", { position: [100, 100] });
    ed.must({ type: "prop.setExpression", layerId: id, path: "transform.position", expression: "value + [time * 10, 0]" });
    expect(pos(ed, id, 2)).toEqual([120, 100]);
    ed.must({ type: "prop.setExpression", layerId: id, path: "transform.opacity", expression: "x = 25; y = x * 2; time > 1 ? y : 100" });
    expect(opacity(ed, id, 0.5)).toBeCloseTo(1);
    expect(opacity(ed, id, 1.5)).toBeCloseTo(0.5);
  });

  it("wiggle is deterministic, bounded and differs per layer", () => {
    const ed = new Editor(makeProject());
    const a = add(ed, "null", { position: [500, 500] });
    const b = add(ed, "null", { position: [500, 500] });
    for (const id of [a, b]) ed.must({ type: "prop.setExpression", layerId: id, path: "transform.position", expression: "wiggle(3, 40)" });
    const samples = Array.from({ length: 60 }, (_, i) => pos(ed, a, i / 10));
    expect(samples.every(([x, y]) => Math.abs(x - 500) <= 80 && Math.abs(y - 500) <= 80)).toBe(true);
    expect(new Set(samples.map((p) => p.join())).size).toBeGreaterThan(30);
    expect(pos(ed, a, 1.234)).toEqual(pos(ed, a, 1.234));
    expect(pos(ed, a, 1.234)).not.toEqual(pos(ed, b, 1.234));
  });

  it("loopOut cycles, ping-pongs and offsets keyframes", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "null");
    ed.must({ type: "prop.setKeyframes", layerId: id, path: "transform.rotation", keyframes: [{ t: 0, v: 0 }, { t: 1, v: 90 }] });
    const rot = (t: number) => {
      const m = layerOf(ed, id, t).matrix;
      return Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI);
    };
    ed.must({ type: "prop.setExpression", layerId: id, path: "transform.rotation", expression: 'loopOut("cycle")' });
    expect(rot(1.5)).toBe(45);
    ed.must({ type: "prop.setExpression", layerId: id, path: "transform.rotation", expression: 'loopOut("pingpong")' });
    expect(rot(1.25)).toBe(68); // 90 -> 0 on the way back: 67.5
    ed.must({ type: "prop.setExpression", layerId: id, path: "transform.rotation", expression: 'loopOut("offset")' });
    expect(rot(1.5)).toBe(135);
  });

  it("links to another layer's property, and link loops fall back safely", () => {
    const ed = new Editor(makeProject());
    const leader = add(ed, "null", { name: "Leader", position: [300, 200] });
    const follower = add(ed, "null", { name: "Follower" });
    ed.must({ type: "prop.setKeyframes", layerId: leader, path: "transform.position", keyframes: [{ t: 0, v: [0, 0] }, { t: 2, v: [200, 0] }] });
    ed.must({ type: "prop.setExpression", layerId: follower, path: "transform.position", expression: 'prop("Leader", "transform.position", time - 0.5) + [0, 100]' });
    expect(pos(ed, follower, 1.5)).toEqual([100, 100]);
    ed.must({ type: "prop.setExpression", layerId: leader, path: "transform.opacity", expression: 'prop("Follower", "transform.opacity")' });
    ed.must({ type: "prop.setExpression", layerId: follower, path: "transform.opacity", expression: 'prop("Leader", "transform.opacity") / 2' });
    expect(Number.isFinite(opacity(ed, leader, 1))).toBe(true);
  });

  it("rejects bad syntax at edit time and reports runtime errors without breaking the render", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "null", { position: [10, 10] });
    expect(() => ed.must({ type: "prop.setExpression", layerId: id, path: "transform.position", expression: "value + [" })).toThrow(/Expression error/);
    expect(() => ed.must({ type: "prop.setExpression", layerId: id, path: "transform.position", expression: "window.location" })).toThrow();
    ed.must({ type: "prop.setExpression", layerId: id, path: "transform.position", expression: "nope(1)" });
    expect(pos(ed, id, 0)).toEqual([10, 10]);
    expect(checkExpression(comp(ed), id, "transform.position", 0).error).toMatch(/Unknown function/);
    ed.must({ type: "prop.setExpression", layerId: id, path: "transform.position", expression: null });
    expect(comp(ed).layers[0].transform.position.expression).toBeUndefined();
  });

  it("colours mix and the text fill can be driven", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "solid", { color: "#000000" });
    ed.must({ type: "prop.setExpression", layerId: id, path: "color", expression: 'mixColor("#000000", "#ffffff", linear(time, 0, 2, 0, 1))' });
    expect((layerOf(ed, id, 1).content as { color: string }).color.toLowerCase()).toMatch(/^#80808|^#7f7f7f/);
  });
});

describe("repeaters and path offset (ED-09)", () => {
  it("a repeater draws N copies with accumulating transforms and fading opacity", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "shape", { size: [50, 50] });
    ed.must({ type: "shape.addOperator", layerId: id, operator: "repeater" });
    ed.must({ type: "prop.set", layerId: id, path: "repeater.copies", value: 5 });
    ed.must({ type: "prop.set", layerId: id, path: "repeater.endOpacity", value: 0 });
    const c = layerOf(ed, id, 0).content as { repeats: { matrix: number[]; opacity: number }[] };
    expect(c.repeats).toHaveLength(5);
    expect(c.repeats.map((r) => r.matrix[4])).toEqual([0, 100, 200, 300, 400]);
    expect(c.repeats.map((r) => r.opacity)).toEqual([1, 0.75, 0.5, 0.25, 0]);
    ed.must({ type: "prop.set", layerId: id, path: "repeater.rotation", value: 90 });
    ed.must({ type: "prop.set", layerId: id, path: "repeater.position", value: [0, 0] });
    const r2 = (layerOf(ed, id, 0).content as { repeats: { matrix: number[] }[] }).repeats;
    expect(Math.round(r2[2].matrix[0])).toBe(-1); // two quarter turns
    const { body } = sceneToVNodes(scene(ed, 0), () => 10);
    const reps: string[] = [];
    const walk = (n: { key: string; children?: unknown[] }[]) => n.forEach((x) => (x.key.startsWith("rep") && reps.push(x.key), x.children && walk(x.children as never)));
    walk(body as never);
    expect(reps).toHaveLength(5);
    ed.must({ type: "shape.removeOperator", layerId: id, operator: "repeater" });
    expect((comp(ed).layers[0] as ShapeLayer).repeater).toBeUndefined();
  });

  it("offset path grows rects and ellipses exactly and paths approximately", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "shape", { size: [100, 50] });
    ed.must({ type: "shape.addOperator", layerId: id, operator: "offsetPath" });
    ed.must({ type: "prop.set", layerId: id, path: "offsetPath.amount", value: 10 });
    const d = (layerOf(ed, id, 0).content as { paths: string[] }).paths[0];
    expect(d).toContain("-60"); // half width 50 + 10
    const square = { closed: true, points: [[0, 0], [100, 0], [100, 100], [0, 100]].map((p) => ({ p: p as Vec2, in: [0, 0] as Vec2, out: [0, 0] as Vec2 })) };
    const grown = offsetPathD(square, 10, "miter");
    const nums = grown.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(Math.min(...nums)).toBeCloseTo(-10, 1);
    expect(Math.max(...nums)).toBeCloseTo(110, 1);
    const shrunk = offsetPathD(square, -10, "miter").match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(Math.min(...shrunk)).toBeCloseTo(10, 1);
    expect(() => ed.must({ type: "shape.addOperator", layerId: add(ed, "null"), operator: "repeater" })).toThrow();
  });
});

describe("brand kits (ED-15) and templates (ED-16)", () => {
  const kit = { name: "Acme", colors: [{ name: "Primary", color: "#ff0000" }], fonts: [{ name: "Head", family: "Futura", weight: 700 }] };

  it("a brand colour linked by expression follows the kit", () => {
    const ed = new Editor(makeProject());
    ed.must({ type: "brand.set", brand: kit });
    const id = add(ed, "solid");
    ed.must({ type: "prop.setExpression", layerId: id, path: "color", expression: 'brand("Primary")' });
    expect((layerOf(ed, id, 0).content as { color: string }).color).toBe("#ff0000");
    ed.must({ type: "brand.set", brand: { ...kit, colors: [{ name: "Primary", color: "#00ff00" }] } });
    expect((layerOf(ed, id, 0).content as { color: string }).color).toBe("#00ff00");
    expect(() => ed.must({ type: "brand.set", brand: { ...kit, colors: [{ name: "X", color: "red" }] } })).toThrow();
  });

  it("template fields fill text, colours and animated positions, and survive duplicate", () => {
    const ed = new Editor(makeProject());
    const title = add(ed, "text", { text: "Name", name: "Title" });
    const bar = add(ed, "shape", { name: "Bar" });
    ed.must({ type: "prop.setKeyframes", layerId: bar, path: "transform.position", keyframes: [{ t: 0, v: [0, 500] }, { t: 1, v: [100, 500] }] });
    ed.must({ type: "template.addField", layerId: title, path: "text", name: "Name" });
    ed.must({ type: "template.addField", layerId: bar, path: "fill.paint.color", name: "Accent" });
    ed.must({ type: "template.addField", layerId: bar, path: "transform.position", name: "Where" });
    expect(() => ed.must({ type: "template.addField", layerId: bar, path: "transform.rotation", name: "Name" })).toThrow(/already/);
    ed.must({ type: "template.fill", values: { name: "Ada Lovelace", Accent: "#22c55e", Where: [50, 600] } });
    const c = comp(ed);
    expect((c.layers.find((l) => l.id === title) as { text: string }).text).toBe("Ada Lovelace");
    expect(pos(ed, bar, 1)).toEqual([150, 600]);
    expect(() => ed.must({ type: "template.fill", values: { Nope: 1 } })).toThrow(/No template field/);
    const dup = (ed.must({ type: "comp.duplicate" })[0] as { compId: string }).compId;
    const d = ed.project.compositions.find((x) => x.id === dup)!;
    expect(d.template!.fields.every((f) => d.layers.some((l) => l.id === f.layerId))).toBe(true);
    ed.must({ type: "layer.delete", layerIds: [title] });
    expect(comp(ed).template!.fields.map((f) => f.name)).toEqual(["Accent", "Where"]);
  });
});

describe("audio analysis (ED-14)", () => {
  it("finds 120 BPM and its beat grid in a click track with noise", async () => {
    const { detectBeats, waveformPeaks } = await import("../src/core/beats");
    const sr = 22050;
    const s = new Float32Array(sr * 8);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < s.length; i++) s[i] = rnd() * 0.02;
    for (let t = 0.25; t < 8; t += 0.5) for (let i = 0; i < 800; i++) s[Math.floor(t * sr) + i] += Math.sin(i / 3) * Math.exp(-i / 200);
    const r = detectBeats(s, sr);
    expect(r.bpm).toBeGreaterThan(117);
    expect(r.bpm).toBeLessThan(123);
    expect(r.onsets.length).toBeGreaterThanOrEqual(14);
    const near = r.beats.filter((b) => {
      const d = (((b - 0.25) % 0.5) + 0.5) % 0.5;
      return d < 0.04 || d > 0.46;
    });
    expect(near.length / r.beats.length).toBeGreaterThan(0.8);
    const peaks = waveformPeaks(s, 100);
    expect(peaks.length).toBe(100);
    expect(Math.max(...peaks)).toBeGreaterThan(0.5);
  });
});

describe("linked video and sound (layer.linkId)", () => {
  // A video layer and its sound, as an import of a video with audio creates them.
  const linkedPair = () => {
    const ed = new Editor(makeProject());
    const asset = { id: "asset_v", name: "clip.mp4", kind: "video" as const, src: "assets/clip.mp4", width: 1920, height: 1080, duration: 20 };
    ed.must([
      { type: "asset.add", asset },
      { type: "layer.add", layerType: "video", opts: { id: "vid", assetId: "asset_v", outPoint: 10 } as never },
      { type: "layer.add", layerType: "audio", opts: { id: "aud", assetId: "asset_v", outPoint: 10 } as never },
      { type: "layer.update", layerId: "vid", patch: { linkId: "link_1" } },
      { type: "layer.update", layerId: "aud", patch: { linkId: "link_1" } },
    ]);
    const get = (id: string) => ed.project.compositions[0].layers.find((l) => l.id === id) as Layer & { mediaOffset: number };
    return { ed, get };
  };

  it("moving or trimming one moves or trims the other", () => {
    const { ed, get } = linkedPair();
    ed.must({ type: "layer.shiftTime", layerIds: ["aud"], delta: 2 });
    expect([get("vid").inPoint, get("vid").outPoint]).toEqual([2, 12]);
    ed.must({ type: "layer.update", layerId: "vid", patch: { outPoint: 9 } });
    expect(get("aud").outPoint).toBe(9);
    ed.must({ type: "layer.update", layerId: "vid", patch: { mediaOffset: 1.5 } });
    expect(get("aud").mediaOffset).toBe(1.5);
    ed.undo();
    expect(get("aud").mediaOffset).toBe(0); // one undo step for both
  });

  it("split cuts both, and the second halves continue the footage and sound", () => {
    const { ed, get } = linkedPair();
    const [{ layerId: v2 }] = ed.must({ type: "layer.split", layerId: "vid", t: 4 }) as { layerId: string }[];
    const layers = ed.project.compositions[0].layers;
    expect(layers.length).toBe(4);
    const a2 = layers.find((l) => l.type === "audio" && l.id !== "aud")!.id;
    expect([get("vid").outPoint, get("aud").outPoint]).toEqual([4, 4]);
    expect([get(v2).inPoint, get(v2).mediaOffset, get(a2).mediaOffset]).toEqual([4, 4, 4]);
    expect(get(v2).linkId).toBe(get(a2).linkId);
    expect(get(v2).linkId).not.toBe("link_1"); // the halves are separate pairs
    ed.must({ type: "layer.shiftTime", layerIds: [v2], delta: 1 });
    expect([get("vid").inPoint, get(a2).inPoint]).toEqual([0, 5]);
  });

  it("delete removes both; duplicate copies both as a new pair", () => {
    const { ed, get } = linkedPair();
    const [{ layerId: v2 }] = ed.must({ type: "layer.duplicate", layerId: "vid" }) as { layerId: string }[];
    const copies = ed.project.compositions[0].layers.filter((l) => l.id !== "vid" && l.id !== "aud");
    expect(copies.map((l) => l.type).sort()).toEqual(["audio", "video"]);
    expect(copies[0].linkId).toBe(copies[1].linkId);
    expect(get(v2).linkId).not.toBe("link_1");
    ed.must({ type: "layer.delete", layerIds: ["aud"] });
    expect(ed.project.compositions[0].layers.map((l) => l.id)).toEqual(copies.map((l) => l.id));
  });

  it("unlinked layers move on their own again", () => {
    const { ed, get } = linkedPair();
    ed.must({ type: "layer.update", layerId: "aud", patch: { linkId: null } });
    ed.must({ type: "layer.shiftTime", layerIds: ["vid"], delta: 3 });
    expect([get("vid").inPoint, get("aud").inPoint]).toEqual([3, 0]);
  });
});
