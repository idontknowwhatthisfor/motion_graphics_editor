import { describe, expect, it } from "vitest";
import {
  Editor,
  cubicBezier,
  easePreset,
  evaluateComposition,
  makeProject,
  valueAt,
  selectorAmount,
  parseProject,
  serializeProject,
  trimDash,
  type Prop,
  type Vec2,
  type TextLayer,
} from "../src/core";

const add = (ed: Editor, layerType: any, opts: any = {}) =>
  (ed.must({ type: "layer.add", layerType, opts })[0] as { layerId: string }).layerId;

describe("easing", () => {
  it("cubic-bezier endpoints and symmetry", () => {
    expect(cubicBezier(0.42, 0, 0.58, 1, 0)).toBe(0);
    expect(cubicBezier(0.42, 0, 0.58, 1, 1)).toBe(1);
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 5);
    expect(cubicBezier(0, 0, 1, 1, 0.3)).toBeCloseTo(0.3, 5);
  });
  it("back easing overshoots", () => {
    const e = easePreset("easeOutBack") as any;
    let max = 0;
    for (let x = 0; x <= 1; x += 0.01) max = Math.max(max, cubicBezier(e.x1, e.y1, e.x2, e.y2, x));
    expect(max).toBeGreaterThan(1.05);
  });
});

describe("interpolation", () => {
  const p: Prop<number> = {
    value: 0,
    keyframes: [
      { id: "a", t: 0, v: 0, ease: { kind: "linear" } },
      { id: "b", t: 1, v: 100, ease: { kind: "hold" } },
      { id: "c", t: 2, v: 50, ease: { kind: "linear" } },
    ],
  };
  it("linear, hold, clamping", () => {
    expect(valueAt(p, -1)).toBe(0);
    expect(valueAt(p, 0.25)).toBeCloseTo(25);
    expect(valueAt(p, 1.5)).toBe(100);
    expect(valueAt(p, 2)).toBe(50);
    expect(valueAt(p, 9)).toBe(50);
  });
  it("vec2 and colour", () => {
    const v: Prop<Vec2> = { value: [0, 0], keyframes: [
      { id: "a", t: 0, v: [0, 0], ease: { kind: "linear" } },
      { id: "b", t: 2, v: [10, 20], ease: { kind: "linear" } },
    ] };
    expect(valueAt(v, 1)).toEqual([5, 10]);
    const c: Prop<string> = { value: "#000000", keyframes: [
      { id: "a", t: 0, v: "#000000", ease: { kind: "linear" } },
      { id: "b", t: 1, v: "#ffffff", ease: { kind: "linear" } },
    ] };
    expect(valueAt(c, 0.5)).toBe("#808080");
  });
  it("motion path tangents bend the path", () => {
    const v: Prop<Vec2> = { value: [0, 0], keyframes: [
      { id: "a", t: 0, v: [0, 0], ease: { kind: "linear" }, spatialOut: [0, 100] },
      { id: "b", t: 1, v: [100, 0], ease: { kind: "linear" }, spatialIn: [0, 100] },
    ] };
    expect(valueAt(v, 0.5)[1]).toBeCloseTo(75);
  });
});

describe("text selector", () => {
  it("square selector covers characters proportionally", () => {
    expect(selectorAmount("square", 0, 50, 0, 0, 4)).toBe(1);
    expect(selectorAmount("square", 0, 50, 0, 2, 4)).toBe(0);
    expect(selectorAmount("square", 0, 37.5, 0, 1, 4)).toBeCloseTo(0.5);
  });
});

describe("trim paths", () => {
  it("untrimmed returns null, trimmed returns dashes", () => {
    expect(trimDash(0, 100, 0)).toBeNull();
    expect(trimDash(0, 50, 0)!.dasharray).toBe("0 0 50 50");
  });
});

describe("Command API + undo", () => {
  it("adds layers, sets keyframes, undoes and redoes", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "shape", { name: "Box" });
    ed.must({ type: "prop.setKeyframes", layerId: id, path: "transform.position", keyframes: [
      { t: 0, v: [0, 540] }, { t: 1, v: [960, 540], ease: easePreset("easeOut") },
    ] });
    const comp = ed.project.compositions[0];
    const scene = evaluateComposition(ed.project, comp, 0.5);
    expect(scene.layers[0].matrix[4]).toBeCloseTo(480);
    expect(ed.past.length).toBe(2);
    ed.undo();
    expect(ed.project.compositions[0].layers[0].transform.position.keyframes).toBeUndefined();
    ed.undo();
    expect(ed.project.compositions[0].layers.length).toBe(0);
    ed.redo();
    ed.redo();
    expect(ed.project.compositions[0].layers[0].transform.position.keyframes!.length).toBe(2);
  });

  it("rejects bad input without changing the project", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "shape");
    const before = ed.project;
    const r = ed.dispatch({ type: "prop.set", layerId: id, path: "transform.position", value: 5 });
    expect(r.ok).toBe(false);
    expect(ed.project).toBe(before);
    const r2 = ed.dispatch({ type: "prop.set", layerId: id, path: "nope.nothing", value: 5 });
    expect(r2.error).toMatch(/Property not found/);
  });

  it("batches are atomic", () => {
    const ed = new Editor(makeProject());
    const r = ed.dispatch([
      { type: "layer.add", layerType: "null" },
      { type: "comp.update", fps: -1 },
    ]);
    expect(r.ok).toBe(false);
    expect(ed.project.compositions[0].layers.length).toBe(0);
  });

  it("coalesces drags into one undo step", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "shape");
    for (let i = 0; i < 10; i++)
      ed.must({ type: "prop.set", layerId: id, path: "transform.position", value: [i, i] }, { coalesceKey: "drag1" });
    expect(ed.past.length).toBe(2);
    ed.undo();
    expect(ed.project.compositions[0].layers[0].transform.position.value).toEqual([960, 540]);
  });

  it("parenting composes transforms and refuses cycles", () => {
    const ed = new Editor(makeProject());
    const parent = add(ed, "null", { position: [100, 100] });
    const child = add(ed, "shape", { position: [10, 0] });
    ed.must({ type: "layer.update", layerId: child, patch: { parentId: parent } });
    ed.must({ type: "prop.set", layerId: parent, path: "transform.rotation", value: 90 });
    const s = evaluateComposition(ed.project, ed.project.compositions[0], 0);
    const c = s.layers.find((l) => l.id === child)!;
    expect(c.matrix[4]).toBeCloseTo(100);
    expect(c.matrix[5]).toBeCloseTo(110);
    expect(ed.dispatch({ type: "layer.update", layerId: parent, patch: { parentId: child } }).ok).toBe(false);
  });

  it("fps change keeps keyframe timing in seconds; resize scales to fit", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "shape", { position: [1920, 1080] });
    ed.must({ type: "keyframe.add", layerId: id, path: "transform.opacity", t: 1.5, v: 50 });
    ed.must({ type: "comp.update", fps: 24 });
    expect(ed.project.compositions[0].layers[0].transform.opacity.keyframes![0].t).toBe(1.5);
    ed.must({ type: "comp.resize", width: 1080, height: 1080, mode: "scaleToFit" });
    const l = ed.project.compositions[0].layers[0];
    const s = 1080 / 1920;
    expect(l.transform.position.value[0]).toBeCloseTo(540 + 960 * s);
    expect(l.transform.scale.value[0]).toBeCloseTo(100 * s);
  });

  it("split and trim", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "shape");
    const [{ layerId: b }] = ed.must({ type: "layer.split", layerId: id, t: 5 }) as any;
    const layers = ed.project.compositions[0].layers;
    expect(layers.find((l) => l.id === id)!.outPoint).toBe(5);
    expect(layers.find((l) => l.id === b)!.inPoint).toBe(5);
    expect(ed.dispatch({ type: "layer.update", layerId: id, patch: { inPoint: 6 } }).ok).toBe(false);
  });

  it("text animators resolve per character", () => {
    const ed = new Editor(makeProject());
    const id = add(ed, "text", { text: "ABCD" });
    const [{ animatorId }] = ed.must({ type: "animator.add", layerId: id, preset: "fadeIn" }) as any;
    ed.must({ type: "prop.set", layerId: id, path: `animators.${animatorId}.selector.start`, value: 50 });
    const s = evaluateComposition(ed.project, ed.project.compositions[0], 0);
    const c = s.layers[0].content as any;
    expect(c.chars.map((x: any) => Math.round(x.opacity * 100) / 100)).toEqual([1, 1, 0, 0]);
    expect((ed.project.compositions[0].layers[0] as TextLayer).animators.length).toBe(1);
  });
});

describe("change sets", () => {
  it("Claude's edits can be kept as one undo step", () => {
    const ed = new Editor(makeProject());
    const cs = ed.beginChangeSet("Lower third");
    ed.must({ type: "layer.add", layerType: "text" }, { source: "claude" });
    ed.must({ type: "layer.add", layerType: "shape" }, { source: "claude" });
    expect(ed.past.length).toBe(0);
    ed.finishChangeSet(cs.id);
    expect(ed.projectBefore(cs.id).compositions[0].layers.length).toBe(0);
    ed.keepChangeSet(cs.id);
    expect(ed.past.length).toBe(1);
    ed.undo();
    expect(ed.project.compositions[0].layers.length).toBe(0);
  });

  it("rejecting restores the project, even with user edits elsewhere", () => {
    const ed = new Editor(makeProject());
    const mine = add(ed, "null");
    const r = ed.dispatch({ type: "layer.add", layerType: "shape" }, { source: "claude" });
    ed.must({ type: "prop.set", layerId: mine, path: "transform.rotation", value: 45 });
    ed.rejectChangeSet(r.changeSetId!);
    const layers = ed.project.compositions[0].layers;
    expect(layers.length).toBe(1);
    expect(layers[0].transform.rotation.value).toBe(45);
  });

  it("undoing my earlier edit while Claude's layers sit above it hits the right layer", () => {
    const ed = new Editor(makeProject());
    const mine = add(ed, "null");
    ed.must({ type: "prop.set", layerId: mine, path: "transform.rotation", value: 30 });
    ed.dispatch({ type: "layer.add", layerType: "shape" }, { source: "claude" }); // inserted at index 0
    ed.undo(); // undo MY rotation, not Claude's layer
    const layers = ed.project.compositions[0].layers;
    expect(layers.length).toBe(2);
    expect(layers.find((l) => l.id === mine)!.transform.rotation.value).toBe(0);
    expect(layers[0].type).toBe("shape");
  });

  it("Claude cannot change the permission mode", () => {
    const ed = new Editor(makeProject());
    expect(ed.dispatch({ type: "project.setPermissionMode", mode: "autoKeep" }, { source: "claude" }).ok).toBe(false);
  });

  it("read-only mode blocks Claude, auto-keep keeps", () => {
    const ed = new Editor(makeProject());
    ed.must({ type: "project.setPermissionMode", mode: "readOnly" });
    expect(ed.dispatch({ type: "layer.add", layerType: "null" }, { source: "claude" }).ok).toBe(false);
    ed.must({ type: "project.setPermissionMode", mode: "autoKeep" });
    const r = ed.dispatch({ type: "layer.add", layerType: "null" }, { source: "claude" });
    ed.finishChangeSet(r.changeSetId!);
    expect(ed.changeSets[0].status).toBe("kept");
    expect(ed.audit.some((a) => !a.ok)).toBe(true);
  });
});

describe("project io", () => {
  it("round-trips", () => {
    const p = makeProject("X");
    expect(parseProject(serializeProject(p))).toEqual(p);
    expect(() => parseProject({ format: "nope" })).toThrow();
  });
});
