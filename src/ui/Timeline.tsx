import { useLayoutEffect, useRef } from "react";
import { easeName } from "../core/easing";
import { isAnimated, valueAt } from "../core/interpolate";
import { newId } from "../core/id";
import { getProp, listProps } from "../core/props";
import type { AudioLayer, Composition, Layer, Prop } from "../core/types";
import { usePeaks } from "./audio";
import { GraphEditor } from "./GraphEditor";
import { activeComp, getUI, run, setTime, setUI, snapTime, toast, useProject, useUI, type KeySel } from "./state";

const NAME_W = 280;
const ROW_H = 24;

const TRANSFORM_ROWS: [string, string][] = [
  ["transform.anchor", "Anchor point"],
  ["transform.position", "Position"],
  ["transform.scale", "Scale"],
  ["transform.rotation", "Rotation"],
  ["transform.opacity", "Opacity"],
];

export function propLabel(path: string): string {
  const known = TRANSFORM_ROWS.find((r) => r[0] === path);
  if (known) return known[1];
  return path
    .split(".")
    .filter((s) => !/^[a-z]+_[a-z0-9]{8}$/.test(s) && !/^\d+$/.test(s))
    .slice(-2)
    .join(" ");
}

/** Rows shown under an expanded layer: transform + anything animated. */
export function rowsFor(layer: Layer): string[] {
  const rows = TRANSFORM_ROWS.map((r) => r[0]);
  for (const { path, prop } of listProps(layer)) if (isAnimated(prop) && !rows.includes(path)) rows.push(path);
  return rows;
}

/** A chain-link icon: grey when unlinked, blue when linked (see Layer.linkId). */
function LinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}

/** Linked: click to unlink. Unlinked: click to link this layer with the other selected layers. */
function LinkButton({ layer, linked }: { layer: Layer; linked: Layer[] }) {
  const on = linked.length > 0;
  const link = () => {
    const others = getUI().selection.filter((id) => id !== layer.id);
    if (!others.length) return toast("Shift-click the layers to link with this one, then click its link icon");
    const linkId = newId("link");
    run([layer.id, ...others].map((id) => ({ type: "layer.update" as const, layerId: id, patch: { linkId } })), { label: "Link layers" });
  };
  const unlink = () => run([layer, ...linked].map((l) => ({ type: "layer.update" as const, layerId: l.id, patch: { linkId: null } })), { label: "Unlink layers" });
  return (
    <button
      className={`icon link${on ? " on" : ""}`}
      aria-pressed={on}
      title={on ? `Linked to ${linked.map((l) => l.name).join(", ")}: moved, trimmed, split and deleted together. Click to unlink.` : "Not linked. Shift-click other layers, then click here to link them with this one."}
      onPointerDown={(e) => e.stopPropagation()} // keep the selection to link with
      onClick={on ? unlink : link}
    >
      <LinkIcon />
    </button>
  );
}

function snapCandidates(comp: Composition, exclude?: string): number[] {
  const c = [0, comp.duration, getUI().time, ...comp.markers.map((m) => m.t)];
  // Linked layers move with the dragged one, so their edges are not targets.
  const link = comp.layers.find((l) => l.id === exclude)?.linkId;
  for (const l of comp.layers) if (l.id !== exclude && !(link && l.linkId === link)) c.push(l.inPoint, l.outPoint);
  return c;
}
function snap(t: number, comp: Composition, zoom: number, exclude?: string, enabled = true): number {
  if (enabled) {
    const thr = 6 / zoom;
    let best = t;
    let bd = thr;
    for (const c of snapCandidates(comp, exclude)) if (Math.abs(c - t) < bd) (bd = Math.abs(c - t)), (best = c);
    if (best !== t) return best;
  }
  return Math.round(t * comp.fps) / comp.fps;
}

function startDrag(e: React.PointerEvent, onMove: (dx: number, ev: PointerEvent) => void, onUp?: () => void) {
  e.stopPropagation();
  e.preventDefault();
  const x0 = e.clientX;
  const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onUp?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Audio waveform drawn inside the layer bar (ED-14). */
function Waveform({ layer, zoom }: { layer: AudioLayer; zoom: number }) {
  const project = useProject();
  const peaks = usePeaks(project.assets.find((a) => a.id === layer.assetId));
  if (!peaks) return null;
  const dur = layer.outPoint - layer.inPoint;
  const w = Math.max(2, dur * zoom);
  const n = Math.min(Math.round(w / 2), 4000);
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const tMedia = layer.mediaOffset + (i / n) * dur;
    const v = peaks[Math.min(peaks.length - 1, Math.floor(tMedia * 100))] ?? 0;
    pts.push(`${((i / n) * w).toFixed(1)},${(10 - v * 9).toFixed(1)}`);
  }
  const top = pts.join(" ");
  const bottom = pts.map((p) => p.replace(/,([\d.]+)$/, (_, y) => `,${(20 - Number(y)).toFixed(1)}`)).reverse().join(" ");
  return (
    <svg className="waveform" width={w} height={20} viewBox={`0 0 ${w} 20`} preserveAspectRatio="none">
      <polygon points={`${top} ${bottom}`} />
    </svg>
  );
}

export function Timeline() {
  const project = useProject();
  const comp = activeComp(project);
  const time = useUI((s) => s.time);
  const zoom = useUI((s) => s.timelineZoom);
  const selection = useUI((s) => s.selection);
  const expanded = useUI((s) => s.expanded);
  const keys = useUI((s) => s.keys);
  const graph = useUI((s) => s.graph);
  const playing = useUI((s) => s.playing);
  const trackRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const width = comp.duration * zoom;
  const frameW = zoom / comp.fps;
  // Scrolled left of the visible track, the playhead would draw over the
  // name column (and the empty area under it), so hide it there.
  const syncPlayhead = () => {
    const b = bodyRef.current;
    if (!b || !playheadRef.current) return;
    playheadRef.current.style.visibility = time * zoom < b.scrollLeft ? "hidden" : "";
    // Span every row, not just the first screenful (bottom: 0 stops at the
    // visible height of the scroll box).
    playheadRef.current.style.height = "0";
    playheadRef.current.style.height = `${b.scrollHeight}px`;
  };
  useLayoutEffect(syncPlayhead);

  const xToTime = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return (clientX - r.left) / zoom;
  };
  const scrub = (e: React.PointerEvent) => {
    setTime(xToTime(e.clientX));
    startDrag(e, (_dx, ev) => setTime(xToTime(ev.clientX)));
  };

  // ruler ticks: every second labelled, frames when zoomed in
  const ticks: JSX.Element[] = [];
  const step = zoom > 300 ? 1 / comp.fps : zoom > 60 ? 0.5 : 1;
  for (let t = 0; t <= comp.duration + 1e-9; t += step) {
    const major = Math.abs(t - Math.round(t)) < 1e-6;
    ticks.push(<div key={t.toFixed(4)} className={major ? "tick major" : "tick"} style={{ left: t * zoom }}>{major ? `${Math.round(t)}s` : ""}</div>);
  }

  const isKeySel = (k: KeySel) => keys.some((s) => s.kfId === k.kfId);
  const keyDown = (e: React.PointerEvent, layer: Layer, path: string, kfId: string) => {
    const k = { layerId: layer.id, path, kfId };
    const sel = e.shiftKey ? (isKeySel(k) ? keys.filter((s) => s.kfId !== kfId) : [...keys, k]) : isKeySel(k) ? keys : [k];
    setUI({ keys: sel, selection: [layer.id] });
    let applied = 0;
    const coalesceKey = `kfmove-${Date.now()}`;
    const anchorKf = getProp(layer, path)?.keyframes?.find((x) => x.id === kfId);
    startDrag(e, (dx, ev) => {
      if (!anchorKf) return;
      const target = snap(anchorKf.t + dx / zoom, comp, zoom, undefined, !ev.altKey);
      const delta = target - anchorKf.t;
      if (Math.abs(delta - applied) < 1e-9) return;
      const byProp = new Map<string, KeySel[]>();
      for (const s of sel) byProp.set(`${s.layerId}|${s.path}`, [...(byProp.get(`${s.layerId}|${s.path}`) ?? []), s]);
      const cmds = [...byProp.values()].map((list) => ({
        type: "keyframe.move" as const,
        layerId: list[0].layerId,
        path: list[0].path,
        keyframeIds: list.map((s) => s.kfId),
        delta: delta - applied,
      }));
      run(cmds, { coalesceKey, label: "Move keyframes" });
      applied = delta;
    });
  };

  const barDown = (e: React.PointerEvent, layer: Layer, mode: "move" | "in" | "out") => {
    if (layer.locked) return;
    setUI({ selection: e.shiftKey ? [...new Set([...selection, layer.id])] : [layer.id] });
    const coalesceKey = `bar-${Date.now()}`;
    const in0 = layer.inPoint;
    const out0 = layer.outPoint;
    let applied = 0;
    startDrag(e, (dx, ev) => {
      if (mode === "move") {
        const target = snap(in0 + dx / zoom, comp, zoom, layer.id, !ev.altKey);
        const d = target - in0;
        if (Math.abs(d - applied) < 1e-9) return;
        run({ type: "layer.shiftTime", layerIds: [layer.id], delta: d - applied }, { coalesceKey, label: "Move layer in time" });
        applied = d;
      } else if (mode === "in") {
        const t = Math.min(out0 - 1 / comp.fps, Math.max(0, snap(in0 + dx / zoom, comp, zoom, layer.id, !ev.altKey)));
        run({ type: "layer.update", layerId: layer.id, patch: { inPoint: t } }, { coalesceKey, label: "Trim layer" });
      } else {
        const t = Math.max(in0 + 1 / comp.fps, snap(out0 + dx / zoom, comp, zoom, layer.id, !ev.altKey));
        run({ type: "layer.update", layerId: layer.id, patch: { outPoint: t } }, { coalesceKey, label: "Trim layer" });
      }
    });
  };

  const toggleStopwatch = (layer: Layer, path: string, prop: Prop) => {
    if (isAnimated(prop)) run({ type: "prop.setKeyframes", layerId: layer.id, path, keyframes: [] });
    else run({ type: "keyframe.add", layerId: layer.id, path, t: time });
  };
  const toggleKeyHere = (layer: Layer, path: string, prop: Prop) => {
    const here = prop.keyframes?.find((k) => Math.abs(k.t - time) < 0.5 / comp.fps);
    if (here) run({ type: "keyframe.remove", layerId: layer.id, path, keyframeIds: [here.id] });
    else run({ type: "keyframe.add", layerId: layer.id, path, t: time });
  };

  const rows: JSX.Element[] = [];
  comp.layers.forEach((layer, index) => {
    const sel = selection.includes(layer.id);
    const open = !!expanded[layer.id];
    const linked = layer.linkId ? comp.layers.filter((l) => l.linkId === layer.linkId && l.id !== layer.id) : [];
    rows.push(
      <div key={layer.id} className={`tl-row layer ${sel ? "sel" : ""} ${layer.visible ? "" : "hidden"}`} style={{ height: ROW_H }}>
        <div className="tl-name" style={{ width: NAME_W }} onPointerDown={(e) => setUI({ selection: e.shiftKey ? [...new Set([...selection, layer.id])] : [layer.id] })}>
          <button className="twisty" onClick={() => setUI({ expanded: { ...expanded, [layer.id]: !open } })}>{open ? "▾" : "▸"}</button>
          <button className="icon" title="Show/hide" onClick={() => run({ type: "layer.update", layerId: layer.id, patch: { visible: !layer.visible } })}>{layer.visible ? "●" : "○"}</button>
          <button className="icon" title="Lock" onClick={() => run({ type: "layer.update", layerId: layer.id, patch: { locked: !layer.locked } })}>{layer.locked ? "🔒" : "·"}</button>
          <LinkButton layer={layer} linked={linked} />
          <span className="idx">{index + 1}</span>
          <span className={`ltype t-${layer.type}`}>{layer.type[0].toUpperCase()}</span>
          <span
            className="lname"
            onDoubleClick={() => {
              const n = window.prompt("Layer name", layer.name);
              if (n) run({ type: "layer.update", layerId: layer.id, patch: { name: n } });
            }}
          >
            {layer.name}
            {layer.parentId && <em className="parent"> ↳ {comp.layers.find((l) => l.id === layer.parentId)?.name}</em>}
            {layer.type === "reference" && <em className="parent"> (not exported)</em>}
          </span>
        </div>
        <div className="tl-track" style={{ width }}>
          <div
            className={`bar t-${layer.type}`}
            style={{ left: layer.inPoint * zoom, width: Math.max(2, (layer.outPoint - layer.inPoint) * zoom) }}
            onPointerDown={(e) => barDown(e, layer, "move")}
          >
            {layer.type === "audio" && <Waveform layer={layer} zoom={zoom} />}
            <div className="trim in" onPointerDown={(e) => barDown(e, layer, "in")} />
            <div className="trim out" onPointerDown={(e) => barDown(e, layer, "out")} />
          </div>
        </div>
      </div>,
    );
    if (!open) return;
    for (const path of rowsFor(layer)) {
      const prop = getProp(layer, path);
      if (!prop) continue;
      const anim = isAnimated(prop);
      const isGraph = graph?.layerId === layer.id && graph.path === path;
      const v = valueAt(prop, time);
      rows.push(
        <div key={`${layer.id}|${path}`} className={`tl-row prop ${isGraph ? "graph-on" : ""}`} style={{ height: ROW_H }}>
          <div className="tl-name" style={{ width: NAME_W }}>
            <button className={`stopwatch ${anim ? "on" : ""}`} title="Animate (stopwatch)" onClick={() => toggleStopwatch(layer, path, prop)}>⏱</button>
            <button className="icon" title="Add/remove keyframe at playhead" onClick={() => toggleKeyHere(layer, path, prop)}>◆</button>
            <span className="pname" title={path} onClick={() => setUI({ graph: isGraph ? null : { layerId: layer.id, path }, selection: [layer.id] })}>
              {propLabel(path)}
            </span>
            <span className="pval">{fmtVal(v)}</span>
          </div>
          <div className="tl-track" style={{ width }}>
            {prop.keyframes?.map((k) => (
              <div
                key={k.id}
                className={`kf ${isKeySel({ layerId: layer.id, path, kfId: k.id }) ? "sel" : ""} ease-${k.ease.kind}`}
                style={{ left: k.t * zoom - 6 }}
                title={`${k.t.toFixed(3)}s · ${easeName(k.ease)}`}
                onPointerDown={(e) => keyDown(e, layer, path, k.id)}
                onDoubleClick={() => setTime(k.t)}
              />
            ))}
          </div>
        </div>,
      );
    }
  });

  return (
    <div className="timeline" data-testid="timeline">
      <div className="tl-toolbar">
        <span className="timecode">{fmtTimecode(time, comp.fps)}</span>
        <button onClick={() => setTime(time - 1 / comp.fps)} title="Previous frame (←)">◀︎|</button>
        <button onClick={() => setUI((s) => ({ playing: !s.playing }))} title="Play/pause (Space)">{playing ? "❚❚" : "▶"}</button>
        <button onClick={() => setTime(time + 1 / comp.fps)} title="Next frame (→)">|▶︎</button>
        <button onClick={() => run({ type: "marker.add", t: time, label: "" })} title="Add marker (M)">+ Marker</button>
        <button disabled={!selection.length} onClick={() => selection.forEach((id) => run({ type: "layer.split", layerId: id, t: time }))} title="Split selected layers at playhead (Cmd+Shift+D)">Split</button>
        <span className="spacer" />
        <label>Zoom <input type="range" min={20} max={1200} value={zoom} onChange={(e) => setUI({ timelineZoom: Number(e.target.value) })} /></label>
      </div>
      <div className="tl-body" ref={bodyRef} onScroll={syncPlayhead}>
        <div className="tl-row ruler-row" style={{ height: 26 }}>
          <div className="tl-name" style={{ width: NAME_W }}>
            <span className="muted">{comp.layers.length} layers · Alt-drag to skip snapping</span>
          </div>
          <div className="tl-track ruler" ref={trackRef} style={{ width }} onPointerDown={scrub}>
            {ticks}
            {comp.markers.map((m) => (
              <div
                key={m.id}
                className="marker"
                style={{ left: m.t * zoom }}
                title={m.label || "Marker"}
                onPointerDown={(e) => {
                  const t0 = m.t;
                  const coalesceKey = `mk-${Date.now()}`;
                  startDrag(e, (dx) => run({ type: "marker.update", markerId: m.id, t: snapTime(t0 + dx / zoom) }, { coalesceKey }));
                }}
                onDoubleClick={() => {
                  const label = window.prompt("Marker label (empty to delete)", m.label);
                  if (label === null) return;
                  if (label === "") run({ type: "marker.remove", markerId: m.id });
                  else run({ type: "marker.update", markerId: m.id, label });
                }}
              >
                <span>{m.label}</span>
              </div>
            ))}
          </div>
        </div>
        {rows}
        <div className="playhead" ref={playheadRef} style={{ left: NAME_W + time * zoom + frameW * 0 }} />
      </div>
      {graph && <GraphEditor />}
    </div>
  );
}

export function fmtVal(v: unknown): string {
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  if (Array.isArray(v)) return v.map((n) => Math.round(n * 10) / 10).join(", ");
  if (typeof v === "string") return v;
  return "path";
}
export function fmtTimecode(t: number, fps: number) {
  const f = Math.round(t * fps);
  const s = Math.floor(f / fps);
  const fr = f % Math.round(fps);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}:${String(fr).padStart(2, "0")}`;
}

