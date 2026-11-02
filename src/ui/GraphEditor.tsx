/**
 * Graph editor (ED-07). Numbers show a value graph; other properties
 * (position, scale, colours, paths) show each segment's eased progress from
 * 0 to 1. Each segment's easing is a cubic-bezier whose two handles can be
 * dragged; linear segments get handles on first drag.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { applyEase, EASE_PRESET_NAMES, easeName, easePreset, type EasePresetName } from "../core/easing";
import { valueAt } from "../core/interpolate";
import { getProp } from "../core/props";
import type { Ease, Keyframe } from "../core/types";
import { propLabel } from "./Timeline";
import { findLayer, run, setTime, setUI, useProject, useUI } from "./state";

const H = 140;
const M = 16;

export function GraphEditor() {
  const project = useProject();
  const graph = useUI((s) => s.graph)!;
  const keys = useUI((s) => s.keys);
  const time = useUI((s) => s.time);
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setW(ref.current?.clientWidth ?? 800));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  void project;
  const layer = findLayer(graph.layerId);
  const prop = layer ? getProp(layer, graph.path) : undefined;
  const kfs = (prop?.keyframes ?? []) as Keyframe[];

  const header = (
    <div className="graph-head">
      <strong>Graph · {layer?.name} · {propLabel(graph.path)}</strong>
      <label>
        Easing for {keys.filter((k) => k.path === graph.path).length || "all"} keyframe(s):{" "}
        <select
          value=""
          onChange={(e) => {
            const sel = keys.filter((k) => k.path === graph.path && k.layerId === graph.layerId).map((k) => k.kfId);
            run({ type: "keyframe.setEase", layerId: graph.layerId, path: graph.path, keyframeIds: sel.length ? sel : undefined, ease: easePreset(e.target.value as EasePresetName) });
          }}
        >
          <option value="" disabled>
            choose preset…
          </option>
          {EASE_PRESET_NAMES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <button onClick={() => setUI({ graph: null })}>Close</button>
    </div>
  );
  if (!layer || !prop || kfs.length < 2)
    return (
      <div className="graph" ref={ref}>
        {header}
        <div className="muted pad">Add at least two keyframes to this property to edit its curve.</div>
      </div>
    );

  const numeric = typeof kfs[0].v === "number";
  const t0 = kfs[0].t;
  const t1 = kfs[kfs.length - 1].t;
  const span = Math.max(1e-6, t1 - t0);
  const X = (t: number) => M + ((t - t0) / span) * (w - 2 * M);
  const T = (x: number) => t0 + ((x - M) / (w - 2 * M)) * span;

  // value range (numbers) including overshoot
  let vMin = 0;
  let vMax = 1;
  if (numeric) {
    vMin = Infinity;
    vMax = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const v = valueAt(prop as never, t0 + (span * i) / 200) as number;
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
    for (const k of kfs) {
      vMin = Math.min(vMin, k.v as number);
      vMax = Math.max(vMax, k.v as number);
    }
    if (vMax - vMin < 1e-6) (vMax += 1), (vMin -= 1);
    const pad = (vMax - vMin) * 0.12;
    vMin -= pad;
    vMax += pad;
  } else {
    vMin = -0.25;
    vMax = 1.25;
  }
  const Y = (v: number) => M + (1 - (v - vMin) / (vMax - vMin)) * (H - 2 * M);
  const V = (y: number) => vMin + (1 - (y - M) / (H - 2 * M)) * (vMax - vMin);

  const segs = kfs.slice(0, -1).map((a, i) => {
    const b = kfs[i + 1];
    const va = numeric ? (a.v as number) : 0;
    let vb = numeric ? (b.v as number) : 1;
    if (numeric && Math.abs(vb - va) < 1e-9) vb = va + (vMax - vMin) * 0.5; // flat segment: handles still usable
    return { a, b, va, vb };
  });

  let d = "";
  segs.forEach(({ a, b, va, vb }, i) => {
    const n = 40;
    for (let s = 0; s <= n; s++) {
      const u = s / n;
      const e = a.ease.kind === "hold" ? (u < 1 ? 0 : 1) : applyEase(a.ease, u);
      const v = numeric ? (a.v as number) + ((b.v as number) - (a.v as number)) * e : e;
      d += `${s === 0 && i === 0 ? "M" : "L"}${X(a.t + (b.t - a.t) * u).toFixed(1)} ${Y(v).toFixed(1)}`;
      void vb;
      void va;
    }
  });

  const dragHandle = (e: React.PointerEvent, segIndex: number, which: 1 | 2) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const { a, b, va, vb } = segs[segIndex];
    const box = ref.current!.querySelector("svg")!.getBoundingClientRect();
    const coalesceKey = `ease-${Date.now()}`;
    const base: Extract<Ease, { kind: "bezier" }> = a.ease.kind === "bezier" ? a.ease : { kind: "bezier", x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
    const move = (ev: PointerEvent) => {
      const x = ev.clientX - box.left;
      const y = ev.clientY - box.top;
      const tx = Math.min(1, Math.max(0, (T(x) - a.t) / (b.t - a.t)));
      const ty = numeric ? (V(y) - va) / (vb - va) : V(y);
      const r = (n: number) => Math.round(n * 1000) / 1000;
      const ease: Ease = which === 1 ? { ...base, x1: r(tx), y1: r(ty) } : { ...base, x2: r(tx), y2: r(ty) };
      run({ type: "keyframe.setEase", layerId: graph.layerId, path: graph.path, keyframeIds: [a.id], ease }, { coalesceKey, label: "Edit easing" });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="graph" ref={ref} data-testid="graph-editor">
      {header}
      <svg width={w} height={H} onPointerDown={(e) => setTime(T(e.clientX - (e.currentTarget as SVGSVGElement).getBoundingClientRect().left))}>
        {!numeric && (
          <>
            <line x1={M} x2={w - M} y1={Y(0)} y2={Y(0)} className="g-grid" />
            <line x1={M} x2={w - M} y1={Y(1)} y2={Y(1)} className="g-grid" />
          </>
        )}
        <line x1={X(time)} x2={X(time)} y1={0} y2={H} className="g-playhead" />
        <path d={d} className="g-curve" />
        {segs.map(({ a, b, va, vb }, i) => {
          if (a.ease.kind === "hold") return null;
          const e = a.ease.kind === "bezier" ? a.ease : { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
          const P = (x: number, y: number) => [X(a.t + (b.t - a.t) * x), Y(numeric ? va + (vb - va) * y : y)];
          const s = P(0, 0);
          const en = numeric ? [X(b.t), Y(b.v as number)] : P(1, 1);
          const h1 = P(e.x1, e.y1);
          const h2 = P(e.x2, e.y2);
          return (
            <g key={a.id}>
              <line x1={s[0]} y1={numeric ? Y(a.v as number) : s[1]} x2={h1[0]} y2={h1[1]} className="g-tan" />
              <line x1={en[0]} y1={en[1]} x2={h2[0]} y2={h2[1]} className="g-tan" />
              <circle cx={h1[0]} cy={h1[1]} r={5} className="g-handle" onPointerDown={(ev) => dragHandle(ev, i, 1)}>
                <title>{easeName(a.ease)}</title>
              </circle>
              <circle cx={h2[0]} cy={h2[1]} r={5} className="g-handle" onPointerDown={(ev) => dragHandle(ev, i, 2)} />
            </g>
          );
        })}
        {kfs.map((k) => (
          <rect key={k.id} x={X(k.t) - 4} y={(numeric ? Y(k.v as number) : Y(kfs.indexOf(k) === 0 ? 0 : 1)) - 4} width={8} height={8} className="g-kf" />
        ))}
        {numeric && (
          <>
            <text x={4} y={M - 6} className="g-label">{Math.round(vMax * 100) / 100}</text>
            <text x={4} y={H - 6} className="g-label">{Math.round(vMin * 100) / 100}</text>
          </>
        )}
      </svg>
    </div>
  );
}
