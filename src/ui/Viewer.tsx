import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { evaluateComposition, worldMatrix } from "../core/evaluate";
import { apply, invert, type Mat } from "../core/geometry";
import { isAnimated, valueAt } from "../core/interpolate";
import type { PathData, PathPoint, Project, Vec2 } from "../core/types";
import { SvgRenderer } from "../render/renderer";
import { assetUrl } from "./api";
import { activeComp, editor, findLayer, run, setUI, useProject, useUI } from "./state";

const PAD = 40;

function parentMatrix(p: Project, layerId: string, t: number): Mat {
  const comp = activeComp(p);
  const l = comp.layers.find((x) => x.id === layerId);
  if (!l?.parentId) return [1, 0, 0, 1, 0, 0];
  const parent = comp.layers.find((x) => x.id === l.parentId);
  return parent ? worldMatrix(comp, parent, t) : [1, 0, 0, 1, 0, 0];
}

export function Viewer() {
  const project = useProject();
  const time = useUI((s) => s.time);
  const selection = useUI((s) => s.selection);
  const tool = useUI((s) => s.tool);
  const previewBefore = useUI((s) => s.previewBefore);
  const showReference = useUI((s) => s.showReference);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SvgRenderer | null>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const [, force] = useState(0);
  const comp = activeComp(project);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    rendererRef.current = new SvgRenderer(stageRef.current!);
    return () => rendererRef.current?.destroy();
  }, []);

  const shown = useMemo(() => (previewBefore ? editor.projectBefore(previewBefore) : project), [project, previewBefore]);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    const c = activeComp(shown);
    r.render(evaluateComposition(shown, c, time, { includeReference: showReference, assetUrl }));
    force((n) => n + 1); // overlay needs fresh bboxes
  }, [shown, time, showReference]);

  const scale = Math.min((size.w - PAD * 2) / comp.width, (size.h - PAD * 2) / comp.height);
  const ox = (size.w - comp.width * scale) / 2;
  const oy = (size.h - comp.height * scale) / 2;
  const toComp = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale];
  };

  // ---------- pen tool state ----------
  const [pen, setPen] = useState<PathPoint[]>([]);
  useEffect(() => {
    if (tool !== "pen") setPen([]);
  }, [tool]);
  const finishPen = (closed: boolean) => {
    if (pen.length < 2) return setPen([]);
    const path: PathData = { closed, points: pen };
    const r = run({ type: "layer.add", layerType: "shape", opts: { name: closed ? "Pen shape" : "Pen path", position: [0, 0] } });
    if (r.ok) {
      const id = (r.results[0] as { layerId: string }).layerId;
      const l = findLayer(id);
      if (l?.type === "shape") {
        run(
          [
            { type: "layer.update", layerId: id, patch: { fill: { enabled: closed }, stroke: { enabled: !closed } } },
            { type: "geometry.add", layerId: id, kind: "path", id: `geo_pen${Date.now().toString(36)}` },
            { type: "geometry.remove", layerId: id, geometryId: l.geometry[0].id },
          ],
          { coalesceKey: `pen-${id}` },
        );
        const g = findLayer(id);
        if (g?.type === "shape") run({ type: "prop.set", layerId: id, path: `geometry.${g.geometry[0].id}.path`, value: path }, { coalesceKey: `pen-${id}` });
        setUI({ selection: [id], tool: "select" });
      }
    }
    setPen([]);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tool !== "pen" || !pen.length) return;
      if (e.key === "Enter") finishPen(false);
      if (e.key === "Escape") setPen([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- pointer handling ----------
  const drag = useRef<null | { kind: string; start: Vec2; data: any }>(null);
  const [rubber, setRubber] = useState<null | [Vec2, Vec2]>(null);

  const hitLayer = (e: React.PointerEvent): string | null => {
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of els) {
      const g = (el as Element).closest?.("[data-layer]");
      if (g && stageRef.current?.contains(g)) {
        const id = g.getAttribute("data-layer")!;
        const l = findLayer(id);
        if (l && !l.locked) return id;
      }
    }
    return null;
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toComp(e);
    if (tool === "select") {
      const id = hitLayer(e);
      if (!id) {
        setUI({ selection: [] });
        return;
      }
      const sel = e.shiftKey ? (selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]) : selection.includes(id) ? selection : [id];
      setUI({ selection: sel });
      const start = sel.map((lid) => {
        const l = findLayer(lid)!;
        return { id: lid, pos: valueAt(l.transform.position, timeRef.current), inv: invert(parentMatrix(editor.project, lid, timeRef.current)) };
      });
      drag.current = { kind: "move", start: p, data: { start, key: `move-${Date.now()}` } };
    } else if (tool === "rect" || tool === "ellipse") {
      drag.current = { kind: "create", start: p, data: null };
      setRubber([p, p]);
    } else if (tool === "text") {
      const text = window.prompt("Text", "Title");
      if (text) {
        const r = run({ type: "layer.add", layerType: "text", opts: { text, position: [Math.round(p[0]), Math.round(p[1])] } });
        if (r.ok) setUI({ selection: [(r.results[0] as { layerId: string }).layerId], tool: "select" });
      }
    } else if (tool === "pen") {
      if (pen.length > 2 && Math.hypot(p[0] - pen[0].p[0], p[1] - pen[0].p[1]) < 10 / scale) return finishPen(true);
      setPen([...pen, { p: [Math.round(p[0]), Math.round(p[1])], in: [0, 0], out: [0, 0] }]);
      drag.current = { kind: "penHandle", start: p, data: null };
    }
  };

  const timeRef = useRef(time);
  timeRef.current = time;

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toComp(e);
    if (d.kind === "move") {
      const dx = p[0] - d.start[0];
      const dy = p[1] - d.start[1];
      if (Math.abs(dx) + Math.abs(dy) < 0.5) return;
      const cmds = d.data.start.map((s: { id: string; pos: Vec2; inv: Mat }) => {
        // convert the comp-space delta into the parent's space
        const a = apply(s.inv, [0, 0]);
        const b = apply(s.inv, [dx, dy]);
        let v: Vec2 = [s.pos[0] + b[0] - a[0], s.pos[1] + b[1] - a[1]];
        if (e.shiftKey) v = Math.abs(dx) > Math.abs(dy) ? [v[0], s.pos[1]] : [s.pos[0], v[1]];
        v = [Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10];
        const l = findLayer(s.id)!;
        return { type: "prop.set" as const, layerId: s.id, path: "transform.position", value: v, ...(isAnimated(l.transform.position) ? { t: timeRef.current } : {}) };
      });
      run(cmds, { coalesceKey: d.data.key, label: "Move layer" });
    } else if (d.kind === "create") setRubber([d.start, p]);
    else if (d.kind === "penHandle") {
      const last = pen[pen.length - 1];
      if (!last) return;
      const out: Vec2 = [p[0] - last.p[0], p[1] - last.p[1]];
      setPen([...pen.slice(0, -1), { ...last, out, in: [-out[0], -out[1]] }]);
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "create" && rubber) {
      const [a, b] = rubber;
      setRubber(null);
      const w = Math.abs(b[0] - a[0]);
      const hgt = Math.abs(b[1] - a[1]);
      if (w < 4 || hgt < 4) return;
      const r = run({
        type: "layer.add",
        layerType: "shape",
        opts: { name: tool === "rect" ? "Rectangle" : "Ellipse", shape: tool as "rect" | "ellipse", size: [Math.round(w), Math.round(hgt)], position: [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2)] },
      });
      if (r.ok) setUI({ selection: [(r.results[0] as { layerId: string }).layerId], tool: "select" });
    }
  };

  // ---------- overlay ----------
  const overlay: JSX.Element[] = [];
  for (const id of selection) {
    const l = comp.layers.find((x) => x.id === id);
    if (!l) continue;
    const m = worldMatrix(comp, l, time);
    const bb = rendererRef.current?.layerBBox(id);
    const anchor = apply(m, valueAt(l.transform.anchor, time));
    if (bb) {
      const pts = [
        [bb.x, bb.y],
        [bb.x + bb.width, bb.y],
        [bb.x + bb.width, bb.y + bb.height],
        [bb.x, bb.y + bb.height],
      ].map((q) => apply(m, q as Vec2));
      overlay.push(<polygon key={`bb${id}`} points={pts.map((q) => q.join(",")).join(" ")} className="ov-box" />);
    }
    overlay.push(
      <g key={`an${id}`} className="ov-anchor">
        <circle cx={anchor[0]} cy={anchor[1]} r={6 / scale} />
        <line x1={anchor[0] - 10 / scale} y1={anchor[1]} x2={anchor[0] + 10 / scale} y2={anchor[1]} />
        <line x1={anchor[0]} y1={anchor[1] - 10 / scale} x2={anchor[0]} y2={anchor[1] + 10 / scale} />
      </g>,
    );
    // Motion path (ED-07): sampled path + keyframe points + spatial tangents.
    const pos = l.transform.position;
    if (pos.keyframes && pos.keyframes.length > 1) {
      const pm = parentMatrix(project, id, time);
      const k = pos.keyframes;
      const samples: string[] = [];
      for (let t = k[0].t; t <= k[k.length - 1].t + 1e-9; t += 1 / comp.fps) {
        const at = apply(pm, valueAt(pos, t));
        samples.push(`${at[0]},${at[1]}`);
      }
      overlay.push(<polyline key={`mp${id}`} points={samples.join(" ")} className="ov-path" />);
      k.forEach((kf, i) => {
        const at = apply(pm, kf.v as Vec2);
        overlay.push(<rect key={`mk${kf.id}`} x={at[0] - 4 / scale} y={at[1] - 4 / scale} width={8 / scale} height={8 / scale} className="ov-kf" />);
        const handles: ["spatialIn" | "spatialOut", boolean][] = [
          ["spatialIn", i > 0],
          ["spatialOut", i < k.length - 1],
        ];
        for (const [side, show] of handles) {
          if (!show) continue;
          const off = kf[side] ?? [0, 0];
          const hp = apply(pm, [(kf.v as Vec2)[0] + off[0], (kf.v as Vec2)[1] + off[1]]);
          overlay.push(<line key={`ml${kf.id}${side}`} x1={at[0]} y1={at[1]} x2={hp[0]} y2={hp[1]} className="ov-tan" />);
          overlay.push(
            <circle
              key={`mh${kf.id}${side}`}
              cx={hp[0]}
              cy={hp[1]}
              r={5 / scale}
              className="ov-handle"
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as Element).setPointerCapture(e.pointerId);
                const inv = invert(pm);
                const key = `tan-${Date.now()}`;
                const move = (ev: PointerEvent) => {
                  const q = apply(inv, toComp(ev));
                  const v: Vec2 = [Math.round(q[0] - (kf.v as Vec2)[0]), Math.round(q[1] - (kf.v as Vec2)[1])];
                  const opp: Vec2 = [-v[0], -v[1]];
                  run(
                    {
                      type: "keyframe.update",
                      layerId: id,
                      path: "transform.position",
                      keyframeId: kf.id,
                      [side]: v,
                      ...(ev.altKey ? {} : { [side === "spatialIn" ? "spatialOut" : "spatialIn"]: opp }),
                    } as never,
                    { coalesceKey: key, label: "Edit motion path" },
                  );
                };
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            />,
          );
        }
      });
    }
  }
  if (rubber) {
    const [a, b] = rubber;
    overlay.push(<rect key="rubber" x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} className="ov-rubber" />);
  }
  if (pen.length) {
    const d = pen.map((pt, i) => (i === 0 ? `M${pt.p[0]} ${pt.p[1]}` : `C${pen[i - 1].p[0] + pen[i - 1].out[0]} ${pen[i - 1].p[1] + pen[i - 1].out[1]} ${pt.p[0] + pt.in[0]} ${pt.p[1] + pt.in[1]} ${pt.p[0]} ${pt.p[1]}`)).join("");
    overlay.push(<path key="pen" d={d} className="ov-pen" />);
    pen.forEach((pt, i) => overlay.push(<rect key={`pp${i}`} x={pt.p[0] - 4 / scale} y={pt.p[1] - 4 / scale} width={8 / scale} height={8 / scale} className="ov-kf" />));
  }
  // Title/action safe guides (80% / 90%).
  const guides = [0.9, 0.8].map((f) => (
    <rect key={`safe${f}`} x={(comp.width * (1 - f)) / 2} y={(comp.height * (1 - f)) / 2} width={comp.width * f} height={comp.height * f} className="ov-safe" />
  ));

  return (
    <div
      ref={wrapRef}
      className={`viewer tool-${tool}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDoubleClick={() => tool === "pen" && finishPen(false)}
      data-testid="viewer"
    >
      <div className="stage-frame" style={{ left: ox, top: oy, width: comp.width * scale, height: comp.height * scale }}>
        <div ref={stageRef} className="stage" style={{ width: comp.width, height: comp.height, transform: `scale(${scale})` }} />
      </div>
      <svg className="overlay" width={size.w} height={size.h}>
        <g transform={`translate(${ox} ${oy}) scale(${scale})`} style={{ vectorEffect: "non-scaling-stroke" } as React.CSSProperties}>
          {guides}
          {overlay}
        </g>
      </svg>
      {previewBefore && <div className="viewer-badge">Showing BEFORE Claude's change set</div>}
      <div className="viewer-info">
        {comp.width}×{comp.height} · {comp.fps} fps · {Math.round(scale * 100)}%{tool === "pen" && " · Pen: click to add points, drag for curves, click the first point to close, Enter to finish"}
      </div>
    </div>
  );
}
