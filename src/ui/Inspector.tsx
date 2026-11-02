import { useRef, useState } from "react";
import { parseColor, formatColor } from "../core/color";
import { isAnimated, valueAt } from "../core/interpolate";
import { prop as mkProp } from "../core/factory";
import { getProp } from "../core/props";
import { checkExpression } from "../core/evaluate";
import type { AnimValue, BlendMode, Effect, EffectKind, Layer, MatteMode, Paint, Vec2 } from "../core/types";
import { compContains } from "../core/commands";
import { activeComp, run, useProject, useUI } from "./state";

const BLEND_MODES: BlendMode[] = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];
const FONTS = ["Inter, Helvetica Neue, Arial, sans-serif", "Helvetica Neue", "SF Pro Display", "Avenir Next", "Futura", "Gill Sans", "Georgia", "Times New Roman", "Menlo", "Arial Black"];

const EFFECT_NAMES: Record<EffectKind, string> = {
  blur: "Blur",
  glow: "Glow",
  dropShadow: "Drop shadow",
  colorCorrect: "Colour correction",
  gradientOverlay: "Gradient overlay",
};

// ---------- value widgets ----------
function NumberField({ value, onChange, step = 1, min, max, onCommit }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; onCommit?: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 1000) / 1000);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0 || document.activeElement === e.currentTarget) return;
    const x0 = e.clientX;
    const v0 = value;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 2) moved = true;
      if (moved) onChange(clamp(Math.round((v0 + dx * step * (ev.shiftKey ? 10 : 1)) * 1000) / 1000));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        ev.preventDefault();
        onCommit?.();
      } else (e.target as HTMLInputElement).focus();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  return (
    <input
      className="num"
      value={shown}
      onPointerDown={scrub}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== "" && Number.isFinite(Number(draft))) onChange(clamp(Number(draft)));
        setDraft(null);
        onCommit?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(null);
        e.stopPropagation();
      }}
    />
  );
}

function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const c = parseColor(value);
  const hex = formatColor({ ...c, a: 1 });
  return (
    <span className="color-field">
      <input type="color" value={hex} onChange={(e) => onChange(formatColor({ ...parseColor(e.target.value), a: c.a }))} />
      <NumberField value={Math.round(c.a * 100)} min={0} max={100} onChange={(a) => onChange(formatColor({ ...c, a: a / 100 }))} />%
    </span>
  );
}

/** An animatable property row: stopwatch, expression toggle and editor. */
function PropRow({ layer, path, label, step, min, max }: { layer: Layer; path: string; label: string; step?: number; min?: number; max?: number }) {
  const time = useUI((s) => s.time);
  const key = useRef(`insp-${Math.random()}`);
  const [exprOpen, setExprOpen] = useState(false);
  const p = getProp(layer, path);
  if (!p) return null;
  const anim = isAnimated(p);
  const v = valueAt(p, time);
  const set = (value: AnimValue) =>
    run({ type: "prop.set", layerId: layer.id, path, value, ...(anim ? { t: time } : {}) }, { coalesceKey: key.current, label: `Set ${label}` });
  const commit = () => (key.current = `insp-${Math.random()}`);
  const onKey = anim && p.keyframes!.some((k) => Math.abs(k.t - time) < 1e-4);
  const canExpr = typeof v === "number" || typeof v === "string" || Array.isArray(v);
  let editor: JSX.Element;
  if (typeof v === "number") editor = <NumberField value={v} step={step} min={min} max={max} onChange={set} onCommit={commit} />;
  else if (typeof v === "string") editor = <ColorField value={v} onChange={set} />;
  else if (Array.isArray(v))
    editor = (
      <>
        <NumberField value={v[0]} step={step} onChange={(x) => set([x, (valueAt(p, time) as Vec2)[1]])} onCommit={commit} />
        <NumberField value={v[1]} step={step} onChange={(y) => set([(valueAt(p, time) as Vec2)[0], y])} onCommit={commit} />
      </>
    );
  else editor = <span className="muted">{v.points.length} points{v.closed ? ", closed" : ""}</span>;
  return (
    <>
      <div className="prow">
        <button
          className={`stopwatch ${anim ? "on" : ""}`}
          title={anim ? "Remove animation" : "Animate: add a keyframe at the playhead"}
          onClick={() => run(anim ? { type: "prop.setKeyframes", layerId: layer.id, path, keyframes: [] } : { type: "keyframe.add", layerId: layer.id, path, t: time })}
        >
          ⏱
        </button>
        {canExpr && (
          <button className={`expr-btn ${p.expression ? "on" : ""}`} title="Expression (wiggle, loopOut, links…)" onClick={() => setExprOpen(!exprOpen)}>
            =
          </button>
        )}
        <span className={`plabel ${onKey ? "onkey" : ""}`}>{label}</span>
        <span className="pedit">{editor}</span>
      </div>
      {(exprOpen || p.expression) && <ExpressionEditor layer={layer} path={path} expression={p.expression ?? ""} onClose={() => setExprOpen(false)} />}
    </>
  );
}

const EXPR_EXAMPLES = ["wiggle(2, 30)", 'loopOut("cycle")', 'loopOut("pingpong")', 'prop("Layer name", "transform.position")', "value + [time * 100, 0]", "linear(time, 0, 1, 0, 100)"];

/** Expression text for one property (ED-12): applied on blur; errors show live. */
function ExpressionEditor({ layer, path, expression, onClose }: { layer: Layer; path: string; expression: string; onClose: () => void }) {
  const project = useProject();
  const time = useUI((s) => s.time);
  const [text, setText] = useState(expression);
  const [err, setErr] = useState<string | null>(null);
  const lastSaved = useRef(expression);
  if (expression !== lastSaved.current) {
    lastSaved.current = expression;
    if (text !== expression) setText(expression);
  }
  const apply = (src: string) => {
    if (src.trim() === expression.trim()) return;
    const r = run({ type: "prop.setExpression", layerId: layer.id, path, expression: src.trim() || null });
    setErr(r.ok ? null : (r.error ?? "Expression error"));
    if (r.ok && !src.trim()) onClose();
  };
  const runtime = expression ? checkExpression(activeComp(project), layer.id, path, time) : {};
  const shown = err ?? runtime.error ?? null;
  return (
    <div className="expr">
      <textarea
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        spellCheck={false}
        placeholder="e.g. wiggle(2, 30)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => apply(text)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) apply(text);
          if (e.key === "Escape") setText(expression);
        }}
      />
      <div className="expr-foot small">
        {shown ? (
          <span className="expr-err">{shown}</span>
        ) : runtime.value !== undefined ? (
          <span className="muted">= {Array.isArray(runtime.value) ? runtime.value.map((n) => +(+n).toFixed(2)).join(", ") : typeof runtime.value === "number" ? +runtime.value.toFixed(3) : String(runtime.value)}</span>
        ) : (
          <select value="" onChange={(e) => setText(e.target.value)}>
            <option value="" disabled>Examples…</option>
            {EXPR_EXAMPLES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        )}
        {expression && <button onClick={() => apply("")}>Remove</button>}
      </div>
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="section">
      <div className="section-head" onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"} {title}</span>
        <span onClick={(e) => e.stopPropagation()}>{right}</span>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

const upd = (layer: Layer, patch: Record<string, unknown>) => run({ type: "layer.update", layerId: layer.id, patch });

function PaintEditor({ layer, base, paint }: { layer: Layer; base: "fill" | "stroke"; paint: Paint }) {
  const setKind = (kind: Paint["kind"]) => {
    if (kind === paint.kind) return;
    const first = paint.kind === "solid" ? paint.color.value : paint.stops[0].color.value;
    const next: Paint =
      kind === "solid"
        ? { kind, color: mkProp(first) }
        : { kind, stops: [{ offset: 0, color: mkProp(first) }, { offset: 1, color: mkProp("#ffffff") }], start: mkProp<Vec2>([-200, 0]), end: mkProp<Vec2>([200, 0]) };
    upd(layer, { [base]: { paint: next } });
  };
  return (
    <>
      <div className="prow">
        <span className="plabel">Paint</span>
        <select value={paint.kind} onChange={(e) => setKind(e.target.value as Paint["kind"])}>
          <option value="solid">Solid colour</option>
          <option value="linear">Linear gradient</option>
          <option value="radial">Radial gradient</option>
        </select>
      </div>
      {paint.kind === "solid" ? (
        <PropRow layer={layer} path={`${base}.paint.color`} label="Colour" />
      ) : (
        <>
          {paint.stops.map((_, i) => (
            <PropRow key={i} layer={layer} path={`${base}.paint.stops.${i}.color`} label={`Stop ${i + 1}`} />
          ))}
          <PropRow layer={layer} path={`${base}.paint.start`} label={paint.kind === "radial" ? "Centre" : "Start"} />
          <PropRow layer={layer} path={`${base}.paint.end`} label={paint.kind === "radial" ? "Edge" : "End"} />
        </>
      )}
    </>
  );
}

function EffectRows({ layer, e, index, count }: { layer: Layer; e: Effect; index: number; count: number }) {
  const base = `effects.${e.id}`;
  const ref = { layerId: layer.id, effectId: e.id };
  return (
    <div className="sub">
      <div className="sub-head">
        <label>
          <input type="checkbox" checked={e.enabled} onChange={(ev) => run({ type: "effect.update", ...ref, enabled: ev.target.checked })} /> {EFFECT_NAMES[e.kind]}
        </label>
        <span>
          <button disabled={index === 0} title="Move up" onClick={() => run({ type: "effect.update", ...ref, toIndex: index - 1 })}>↑</button>
          <button disabled={index === count - 1} title="Move down" onClick={() => run({ type: "effect.update", ...ref, toIndex: index + 1 })}>↓</button>
          <button title="Remove" onClick={() => run({ type: "effect.remove", ...ref })}>✕</button>
        </span>
      </div>
      {e.kind === "blur" && <PropRow layer={layer} path={`${base}.amount`} label="Amount" min={0} />}
      {e.kind === "glow" && (
        <>
          <PropRow layer={layer} path={`${base}.radius`} label="Radius" min={0} />
          <PropRow layer={layer} path={`${base}.intensity`} label="Intensity %" min={0} />
          <PropRow layer={layer} path={`${base}.color`} label="Colour" />
        </>
      )}
      {e.kind === "dropShadow" && (
        <>
          <PropRow layer={layer} path={`${base}.color`} label="Colour" />
          <PropRow layer={layer} path={`${base}.opacity`} label="Opacity %" min={0} max={100} />
          <PropRow layer={layer} path={`${base}.distance`} label="Distance" />
          <PropRow layer={layer} path={`${base}.angle`} label="Angle °" />
          <PropRow layer={layer} path={`${base}.softness`} label="Softness" min={0} />
        </>
      )}
      {e.kind === "colorCorrect" && (
        <>
          <PropRow layer={layer} path={`${base}.brightness`} label="Brightness" min={-100} max={100} />
          <PropRow layer={layer} path={`${base}.contrast`} label="Contrast" min={-100} max={100} />
          <PropRow layer={layer} path={`${base}.saturation`} label="Saturation" min={-100} max={100} />
          <PropRow layer={layer} path={`${base}.hue`} label="Hue °" />
        </>
      )}
      {e.kind === "gradientOverlay" && (
        <>
          <div className="prow">
            <span className="plabel">Type</span>
            <select value={e.gradient} onChange={(ev) => run({ type: "effect.update", ...ref, gradient: ev.target.value as "linear" })}>
              <option value="linear">Linear</option>
              <option value="radial">Radial</option>
            </select>
          </div>
          {e.stops.map((_, i) => (
            <PropRow key={i} layer={layer} path={`${base}.stops.${i}.color`} label={`Stop ${i + 1}`} />
          ))}
          <PropRow layer={layer} path={`${base}.start`} label={e.gradient === "radial" ? "Centre" : "Start"} />
          <PropRow layer={layer} path={`${base}.end`} label={e.gradient === "radial" ? "Edge" : "End"} />
          <PropRow layer={layer} path={`${base}.opacity`} label="Opacity %" min={0} max={100} />
        </>
      )}
    </div>
  );
}

export function Inspector() {
  const project = useProject();
  const selection = useUI((s) => s.selection);
  const comp = activeComp(project);
  const layer = comp.layers.find((l) => l.id === selection[0]);
  if (!layer)
    return (
      <div className="inspector">
        <div className="muted pad">Select a layer to edit its properties. Tools: V select, P pen, R rectangle, E ellipse, T text.</div>
      </div>
    );

  const others = comp.layers.filter((l) => l.id !== layer.id);
  return (
    <div className="inspector" data-testid="inspector">
      <Section title={`${layer.name} (${layer.type})`}>
        <div className="prow">
          <span className="plabel">Name</span>
          <input value={layer.name} onChange={(e) => upd(layer, { name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <div className="prow">
          <span className="plabel">Parent</span>
          <select value={layer.parentId ?? ""} onChange={(e) => upd(layer, { parentId: e.target.value || null })}>
            <option value="">None</option>
            {others.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
        <div className="prow">
          <span className="plabel">Blend</span>
          <select value={layer.blendMode} onChange={(e) => upd(layer, { blendMode: e.target.value })}>
            {BLEND_MODES.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </div>
        <div className="prow">
          <span className="plabel">Track matte</span>
          <select value={layer.matte?.layerId ?? ""} onChange={(e) => upd(layer, { matte: e.target.value ? { layerId: e.target.value, mode: layer.matte?.mode ?? "alpha" } : null })}>
            <option value="">None</option>
            {others.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          {layer.matte && (
            <select value={layer.matte.mode} onChange={(e) => upd(layer, { matte: { ...layer.matte!, mode: e.target.value as MatteMode } })}>
              <option value="alpha">Alpha</option>
              <option value="alphaInverted">Alpha inverted</option>
              <option value="luma">Luma</option>
              <option value="lumaInverted">Luma inverted</option>
            </select>
          )}
        </div>
        <div className="prow">
          <span className="plabel">In / Out (s)</span>
          <NumberField value={layer.inPoint} step={1 / comp.fps} onChange={(v) => upd(layer, { inPoint: v })} />
          <NumberField value={layer.outPoint} step={1 / comp.fps} onChange={(v) => upd(layer, { outPoint: v })} />
        </div>
      </Section>

      <Section title="Transform">
        <PropRow layer={layer} path="transform.anchor" label="Anchor point" />
        <PropRow layer={layer} path="transform.position" label="Position" />
        <PropRow layer={layer} path="transform.scale" label="Scale %" />
        <PropRow layer={layer} path="transform.rotation" label="Rotation °" />
        <PropRow layer={layer} path="transform.opacity" label="Opacity %" min={0} max={100} />
      </Section>

      {layer.type === "solid" && (
        <Section title="Solid">
          <PropRow layer={layer} path="color" label="Colour" />
          <div className="prow">
            <span className="plabel">Size</span>
            <NumberField value={layer.width} onChange={(v) => upd(layer, { width: Math.max(1, v) })} />
            <NumberField value={layer.height} onChange={(v) => upd(layer, { height: Math.max(1, v) })} />
          </div>
        </Section>
      )}

      {layer.type === "shape" && (
        <>
          <Section
            title="Geometry"
            right={
              <>
                <button onClick={() => run({ type: "geometry.add", layerId: layer.id, kind: "rect" })}>+ Rect</button>
                <button onClick={() => run({ type: "geometry.add", layerId: layer.id, kind: "ellipse" })}>+ Ellipse</button>
              </>
            }
          >
            <div className="prow">
              <span className="plabel">Combine</span>
              <select value={layer.combine} onChange={(e) => upd(layer, { combine: e.target.value })}>
                <option value="merge">Merge (union)</option>
                <option value="subtract">Subtract</option>
                <option value="intersect">Intersect</option>
                <option value="exclude">Exclude</option>
              </select>
            </div>
            {layer.geometry.map((g) => (
              <div key={g.id} className="sub">
                <div className="sub-head">
                  {g.kind}
                  <button onClick={() => run({ type: "geometry.remove", layerId: layer.id, geometryId: g.id })}>✕</button>
                </div>
                {g.kind !== "path" ? (
                  <>
                    <PropRow layer={layer} path={`geometry.${g.id}.position`} label="Position" />
                    <PropRow layer={layer} path={`geometry.${g.id}.size`} label="Size" />
                    {g.kind === "rect" && <PropRow layer={layer} path={`geometry.${g.id}.roundness`} label="Roundness" min={0} />}
                  </>
                ) : (
                  <PropRow layer={layer} path={`geometry.${g.id}.path`} label="Path" />
                )}
              </div>
            ))}
          </Section>
          <Section title="Fill" right={<input type="checkbox" checked={layer.fill.enabled} onChange={(e) => upd(layer, { fill: { enabled: e.target.checked } })} />}>
            <PaintEditor layer={layer} base="fill" paint={layer.fill.paint} />
            <PropRow layer={layer} path="fill.opacity" label="Opacity %" min={0} max={100} />
          </Section>
          <Section title="Stroke" right={<input type="checkbox" checked={layer.stroke.enabled} onChange={(e) => upd(layer, { stroke: { enabled: e.target.checked } })} />}>
            <PaintEditor layer={layer} base="stroke" paint={layer.stroke.paint} />
            <PropRow layer={layer} path="stroke.width" label="Width" min={0} />
            <PropRow layer={layer} path="stroke.opacity" label="Opacity %" min={0} max={100} />
            <div className="prow">
              <span className="plabel">Cap / Join</span>
              <select value={layer.stroke.lineCap} onChange={(e) => upd(layer, { stroke: { lineCap: e.target.value } })}>
                <option>butt</option>
                <option>round</option>
                <option>square</option>
              </select>
              <select value={layer.stroke.lineJoin} onChange={(e) => upd(layer, { stroke: { lineJoin: e.target.value } })}>
                <option>miter</option>
                <option>round</option>
                <option>bevel</option>
              </select>
            </div>
          </Section>
          <Section title="Trim paths" right={<input type="checkbox" checked={layer.trim.enabled} onChange={(e) => upd(layer, { trim: { enabled: e.target.checked } })} />}>
            <PropRow layer={layer} path="trim.start" label="Start %" min={0} max={100} />
            <PropRow layer={layer} path="trim.end" label="End %" min={0} max={100} />
            <PropRow layer={layer} path="trim.offset" label="Offset °" />
            <div className="muted small">Trims the stroke.</div>
          </Section>
          <Section
            title="Repeater"
            right={
              layer.repeater ? (
                <>
                  <input type="checkbox" title="On/off" checked={layer.repeater.enabled} onChange={(e) => upd(layer, { repeater: { enabled: e.target.checked } })} />
                  <button title="Remove" onClick={() => run({ type: "shape.removeOperator", layerId: layer.id, operator: "repeater" })}>✕</button>
                </>
              ) : (
                <button onClick={() => run({ type: "shape.addOperator", layerId: layer.id, operator: "repeater" })}>+ Repeater</button>
              )
            }
          >
            {layer.repeater ? (
              <>
                <PropRow layer={layer} path="repeater.copies" label="Copies" min={0} max={200} />
                <PropRow layer={layer} path="repeater.offset" label="Offset" step={0.1} />
                <PropRow layer={layer} path="repeater.position" label="Position" />
                <PropRow layer={layer} path="repeater.anchor" label="Anchor" />
                <PropRow layer={layer} path="repeater.scale" label="Scale %" />
                <PropRow layer={layer} path="repeater.rotation" label="Rotation °" />
                <PropRow layer={layer} path="repeater.startOpacity" label="Start opacity %" min={0} max={100} />
                <PropRow layer={layer} path="repeater.endOpacity" label="End opacity %" min={0} max={100} />
              </>
            ) : (
              <div className="muted small">Copies the shape; each copy adds the position, rotation and scale again (rows, rings, spirals).</div>
            )}
          </Section>
          <Section
            title="Offset path"
            right={
              layer.offsetPath ? (
                <>
                  <input type="checkbox" title="On/off" checked={layer.offsetPath.enabled} onChange={(e) => upd(layer, { offsetPath: { enabled: e.target.checked } })} />
                  <button title="Remove" onClick={() => run({ type: "shape.removeOperator", layerId: layer.id, operator: "offsetPath" })}>✕</button>
                </>
              ) : (
                <button onClick={() => run({ type: "shape.addOperator", layerId: layer.id, operator: "offsetPath" })}>+ Offset</button>
              )
            }
          >
            {layer.offsetPath ? (
              <>
                <PropRow layer={layer} path="offsetPath.amount" label="Amount px" />
                <div className="prow">
                  <span className="plabel">Corners</span>
                  <select value={layer.offsetPath.join} onChange={(e) => upd(layer, { offsetPath: { join: e.target.value } })}>
                    <option value="round">Round</option>
                    <option value="miter">Sharp</option>
                  </select>
                </div>
              </>
            ) : (
              <div className="muted small">Grows (+) or shrinks (−) the shape outline.</div>
            )}
          </Section>
        </>
      )}

      {layer.type === "text" && (
        <>
          <Section title="Text">
            <textarea value={layer.text} rows={2} onChange={(e) => upd(layer, { text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            <div className="prow">
              <span className="plabel">Font</span>
              <input list="fonts" value={layer.style.family} onChange={(e) => upd(layer, { style: { family: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} />
              <datalist id="fonts">
                {FONTS.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>
            <div className="prow">
              <span className="plabel">Weight</span>
              <select value={layer.style.weight} onChange={(e) => upd(layer, { style: { weight: Number(e.target.value) } })}>
                {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
              <label>
                <input type="checkbox" checked={layer.style.italic} onChange={(e) => upd(layer, { style: { italic: e.target.checked } })} /> Italic
              </label>
            </div>
            <div className="prow">
              <span className="plabel">Align</span>
              <select value={layer.style.align} onChange={(e) => upd(layer, { style: { align: e.target.value } })}>
                <option>left</option>
                <option>center</option>
                <option>right</option>
              </select>
              <span className="plabel">Line height</span>
              <NumberField value={layer.style.lineHeight} step={0.01} onChange={(v) => upd(layer, { style: { lineHeight: v } })} />
            </div>
            <PropRow layer={layer} path="style.size" label="Size" min={1} />
            <PropRow layer={layer} path="style.tracking" label="Tracking" />
            <PropRow layer={layer} path="style.fill" label="Colour" />
          </Section>
          <Section
            title="Per-character animators"
            right={
              <select value="" onChange={(e) => run({ type: "animator.add", layerId: layer.id, preset: e.target.value as "fadeIn" })}>
                <option value="" disabled>+ Add…</option>
                <option value="fadeIn">Fade in</option>
                <option value="slideUp">Slide up</option>
                <option value="scaleIn">Scale in</option>
                <option value="blank">Blank</option>
              </select>
            }
          >
            {layer.animators.length === 0 && <div className="muted small">Animate the selector Start from 0 to 100 to reveal characters one by one.</div>}
            {layer.animators.map((a) => (
              <div key={a.id} className="sub">
                <div className="sub-head">
                  {a.name}
                  <select value={a.selector.shape} onChange={(e) => upd(layer, { animators: layer.animators.map((x) => (x.id === a.id ? { ...x, selector: { ...x.selector, shape: e.target.value } } : x)) })}>
                    <option value="square">Square</option>
                    <option value="rampUp">Ramp up</option>
                    <option value="rampDown">Ramp down</option>
                    <option value="triangle">Triangle</option>
                    <option value="smooth">Smooth</option>
                  </select>
                  <select value={a.selector.basedOn} onChange={(e) => upd(layer, { animators: layer.animators.map((x) => (x.id === a.id ? { ...x, selector: { ...x.selector, basedOn: e.target.value } } : x)) })}>
                    <option value="characters">Characters</option>
                    <option value="words">Words</option>
                  </select>
                  <button onClick={() => run({ type: "animator.remove", layerId: layer.id, animatorId: a.id })}>✕</button>
                </div>
                <PropRow layer={layer} path={`animators.${a.id}.selector.start`} label="Start %" />
                <PropRow layer={layer} path={`animators.${a.id}.selector.end`} label="End %" />
                <PropRow layer={layer} path={`animators.${a.id}.selector.offset`} label="Offset %" />
                {a.props.opacity && <PropRow layer={layer} path={`animators.${a.id}.props.opacity`} label="Opacity %" />}
                {a.props.position && <PropRow layer={layer} path={`animators.${a.id}.props.position`} label="Position" />}
                {a.props.scale && <PropRow layer={layer} path={`animators.${a.id}.props.scale`} label="Scale %" />}
                {a.props.rotation && <PropRow layer={layer} path={`animators.${a.id}.props.rotation`} label="Rotation °" />}
                {a.props.fillColor && <PropRow layer={layer} path={`animators.${a.id}.props.fillColor`} label="Fill" />}
                {a.props.blur && <PropRow layer={layer} path={`animators.${a.id}.props.blur`} label="Blur" />}
                <div className="prow">
                  <span className="plabel">Add property</span>
                  <select
                    value=""
                    onChange={(e) => {
                      const k = e.target.value as keyof typeof a.props;
                      const defaults: Record<string, unknown> = { opacity: mkProp(0), position: mkProp<Vec2>([0, 40]), scale: mkProp<Vec2>([0, 0]), rotation: mkProp(45), fillColor: mkProp("#f97316"), blur: mkProp(10) };
                      upd(layer, { animators: layer.animators.map((x) => (x.id === a.id ? { ...x, props: { ...x.props, [k]: defaults[k] } } : x)) });
                    }}
                  >
                    <option value="" disabled>choose…</option>
                    {["opacity", "position", "scale", "rotation", "fillColor", "blur"].filter((k) => !(k in a.props)).map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </Section>
        </>
      )}

      {layer.type === "precomp" && (
        <Section title="Nested comp">
          <div className="prow">
            <span className="plabel">Source</span>
            <select value={layer.compId} onChange={(e) => upd(layer, { compId: e.target.value })}>
              {project.compositions
                .filter((c) => c.id === layer.compId || !compContains(project, c.id, comp.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
            <button title="Open the nested comp" onClick={() => run({ type: "comp.setActive", compId: layer.compId })}>Open</button>
          </div>
          <div className="prow">
            <span className="plabel">Time offset s</span>
            <NumberField value={layer.timeOffset} step={0.1} onChange={(v) => upd(layer, { timeOffset: v })} />
          </div>
        </Section>
      )}

      <Section
        title="Effects"
        right={
          <select data-testid="add-effect" value="" onChange={(e) => run({ type: "effect.add", layerId: layer.id, kind: e.target.value as EffectKind })}>
            <option value="" disabled>+ Add…</option>
            {(Object.keys(EFFECT_NAMES) as EffectKind[]).map((k) => (
              <option key={k} value={k}>{EFFECT_NAMES[k]}</option>
            ))}
          </select>
        }
      >
        {(layer.effects ?? []).length === 0 && <div className="muted small">Effects stack top to bottom and render on the GPU in preview and export.</div>}
        {(layer.effects ?? []).map((e, i, all) => (
          <EffectRows key={e.id} layer={layer} e={e} index={i} count={all.length} />
        ))}
      </Section>

      <Section title="Masks" right={<button onClick={() => run({ type: "mask.add", layerId: layer.id })}>+ Mask</button>}>
        {layer.masks.length === 0 && <div className="muted small">Adds a rectangle mask around the layer origin; animate its path with keyframes.</div>}
        {layer.masks.map((m) => (
          <div key={m.id} className="sub">
            <div className="sub-head">
              {m.name}
              <select value={m.mode} onChange={(e) => run({ type: "mask.update", layerId: layer.id, maskId: m.id, patch: { mode: e.target.value as "add" } })}>
                <option value="add">Add</option>
                <option value="subtract">Subtract</option>
                <option value="intersect">Intersect</option>
              </select>
              <label>
                <input type="checkbox" checked={m.inverted} onChange={(e) => run({ type: "mask.update", layerId: layer.id, maskId: m.id, patch: { inverted: e.target.checked } })} /> Inverted
              </label>
              <button onClick={() => run({ type: "mask.remove", layerId: layer.id, maskId: m.id })}>✕</button>
            </div>
            <PropRow layer={layer} path={`masks.${m.id}.opacity`} label="Opacity %" min={0} max={100} />
            <PropRow layer={layer} path={`masks.${m.id}.feather`} label="Feather" min={0} />
          </div>
        ))}
      </Section>
    </div>
  );
}
