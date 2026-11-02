/**
 * Sample projects built purely through the Command API (so they double as
 * an end-to-end test of it).
 */
import { easePreset } from "./easing";
import { Editor } from "./editor";
import { makeProject } from "./factory";
import type { Project, Vec2 } from "./types";

const id = (r: unknown[]) => (r[0] as { layerId: string }).layerId;

/** A transparent 1080p lower third: bar wipes in, name and role type on. */
export function lowerThirdProject(name = "Your Name", role = "Motion Designer"): Project {
  const ed = new Editor(makeProject("Lower third"));
  ed.must({ type: "comp.update", name: "Lower third", duration: 6, fps: 30 });
  const out = easePreset("easeOutExpo");
  const inn = easePreset("easeInCubic");

  const ctrl = id(ed.must({ type: "layer.add", layerType: "null", opts: { name: "Lower third control", position: [160, 860] } }));

  const bar = id(ed.must({ type: "layer.add", layerType: "shape", opts: { name: "Bar", color: "#111827", position: [0, 0], size: [720, 150] } }));
  ed.must([
    { type: "layer.update", layerId: bar, patch: { parentId: ctrl } },
    { type: "prop.set", layerId: bar, path: "geometry.0.position", value: [360, 0] as Vec2 },
    { type: "prop.set", layerId: bar, path: "geometry.0.roundness", value: 12 },
    { type: "prop.set", layerId: bar, path: "fill.paint.color", value: "#111827e6" },
    { type: "prop.setKeyframes", layerId: bar, path: "transform.scale", keyframes: [
      { t: 0.2, v: [0, 100] as Vec2, ease: out }, { t: 0.9, v: [100, 100] as Vec2, ease: inn },
      { t: 5.2, v: [100, 100] as Vec2, ease: inn }, { t: 5.8, v: [0, 100] as Vec2 },
    ] },
  ]);

  const accent = id(ed.must({ type: "layer.add", layerType: "shape", opts: { name: "Accent", color: "#f97316", position: [0, 0], size: [12, 150] } }));
  ed.must([
    { type: "layer.update", layerId: accent, patch: { parentId: ctrl } },
    { type: "prop.setKeyframes", layerId: accent, path: "transform.scale", keyframes: [
      { t: 0, v: [100, 0] as Vec2, ease: out }, { t: 0.5, v: [100, 100] as Vec2, ease: inn },
      { t: 5.4, v: [100, 100] as Vec2, ease: inn }, { t: 5.9, v: [100, 0] as Vec2 },
    ] },
  ]);

  const title = id(ed.must({ type: "layer.add", layerType: "text", opts: { name: "Name", text: name, fontSize: 64, position: [40, -10] } }));
  const [{ animatorId: a1 }] = ed.must({ type: "animator.add", layerId: title, preset: "slideUp" }) as { animatorId: string }[];
  ed.must([
    { type: "layer.update", layerId: title, patch: { parentId: ctrl, style: { align: "left" } } },
    { type: "prop.set", layerId: title, path: `animators.${a1}.props.position`, value: [0, 40] as Vec2 },
    { type: "prop.setKeyframes", layerId: title, path: `animators.${a1}.selector.start`, keyframes: [
      { t: 0.5, v: 0, ease: easePreset("easeOutCubic") }, { t: 1.3, v: 100 },
    ] },
    { type: "prop.setKeyframes", layerId: title, path: "transform.opacity", keyframes: [
      { t: 5.1, v: 100, ease: inn }, { t: 5.4, v: 0 },
    ] },
  ]);

  const sub = id(ed.must({ type: "layer.add", layerType: "text", opts: { name: "Role", text: role, fontSize: 34, fontWeight: 500, color: "#d1d5db", position: [42, 46] } }));
  ed.must([
    { type: "layer.update", layerId: sub, patch: { parentId: ctrl, style: { align: "left" } } },
    { type: "prop.setKeyframes", layerId: sub, path: "transform.opacity", keyframes: [
      { t: 0.9, v: 0, ease: out }, { t: 1.5, v: 100 }, { t: 5.0, v: 100, ease: inn }, { t: 5.3, v: 0 },
    ] },
    { type: "prop.setKeyframes", layerId: sub, path: "transform.position", keyframes: [
      { t: 0.9, v: [42, 66] as Vec2, ease: out }, { t: 1.5, v: [42, 46] as Vec2 },
    ] },
    { type: "marker.add", t: 0.9, label: "Bar in" },
    { type: "marker.add", t: 5.1, label: "Out" },
  ]);
  return ed.project;
}

/** Engine test (PRD step 1): 15 s, 1080p, 30 animated layers, transparent. */
export function engineTestProject(): Project {
  const ed = new Editor(makeProject("Engine test"));
  ed.must({ type: "comp.update", name: "Engine test", duration: 15, fps: 30 });
  const colors = ["#f97316", "#22c55e", "#3b82f6", "#e11d48", "#a855f7", "#eab308"];
  for (let i = 0; i < 30; i++) {
    const kind = i % 3;
    const x = 160 + (i % 6) * 320;
    const y = 160 + Math.floor(i / 6) * 190;
    const start = (i % 10) * 0.3;
    if (kind === 2) {
      const l = id(ed.must({ type: "layer.add", layerType: "text", opts: { name: `Text ${i}`, text: `Layer ${i + 1}`, fontSize: 48, position: [x, y] } }));
      const [{ animatorId }] = ed.must({ type: "animator.add", layerId: l, preset: "fadeIn" }) as { animatorId: string }[];
      ed.must({ type: "prop.setKeyframes", layerId: l, path: `animators.${animatorId}.selector.start`, keyframes: [{ t: start, v: 0 }, { t: start + 1.5, v: 100 }] });
    } else {
      const l = id(ed.must({ type: "layer.add", layerType: "shape", opts: { name: `Shape ${i}`, shape: kind ? "ellipse" : "rect", size: [140, 140], color: colors[i % colors.length], position: [x, y] } }));
      ed.must([
        { type: "layer.update", layerId: l, patch: { stroke: { enabled: true } } },
        { type: "prop.setKeyframes", layerId: l, path: "transform.rotation", keyframes: [{ t: 0, v: 0, ease: easePreset("easeInOut") }, { t: 15, v: 360 }] },
        { type: "prop.setKeyframes", layerId: l, path: "transform.scale", keyframes: [{ t: start, v: [0, 0] as Vec2, ease: easePreset("easeOutBack") }, { t: start + 0.8, v: [100, 100] as Vec2 }] },
        { type: "prop.setKeyframes", layerId: l, path: "transform.opacity", keyframes: [{ t: 12, v: 100 }, { t: 14.5, v: 40 }] },
        { type: "layer.update", layerId: l, patch: { trim: { enabled: true } } },
        { type: "prop.setKeyframes", layerId: l, path: "trim.end", keyframes: [{ t: start, v: 0 }, { t: start + 2, v: 100 }] },
      ]);
    }
  }
  return ed.project;
}
