import { useEffect, useState } from "react";
import { COMP_PRESETS, FPS_PRESETS } from "../core/factory";
import type { BrandKit, Project, TemplateField, Vec2 } from "../core/types";
import { getProp, listProps } from "../core/props";
import { cancelExport, exportStatus, listLibrary, loadBrandKit, newFromTemplate, saveAsTemplate, saveBrandKit, listVersions, loadVersion, saveProject, startExport, type ExportRequest } from "./api";
import { native } from "./native";
import { answerExportRequest, resumeClaude, stopClaude } from "./bridge-client";
import { activeComp, editor, findLayer, run, setUI, toast, useEditorRevision, useProject, useUI } from "./state";

// ---------- Claude: change sets, status, audit (CL-06, CL-07) ----------
export function ClaudePanel() {
  useEditorRevision();
  const project = useProject();
  const previewBefore = useUI((s) => s.previewBefore);
  const claude = useUI((s) => s.claude);
  const pending = editor.pendingChangeSets;
  const connected = claude.bridge === "up" && claude.agents > 0;
  const statusText = claude.bridge !== "up" ? "bridge offline" : connected ? "connected" : "not connected";
  return (
    <div className="claude-panel" data-testid="claude-panel">
      <div className="section-head static">
        <span>Claude</span>
        <span className={`status ${connected ? "on" : "off"}`} data-testid="claude-status" title={connected ? "An MCP client is connected" : "Run `npm run mcp:setup` once, then ask Claude Code or the Claude app to use the motion-graphics tools"}>
          ● {statusText}
        </span>
      </div>
      {(claude.action || claude.stopped || editor.openChangeSet) && (
        <div className="prow claude-activity">
          <span className="plabel">{claude.stopped ? "Stopped" : claude.action ? "Working" : "Idle"}</span>
          <span className="small">{claude.stopped ? "Claude's edits are blocked" : (claude.action ?? "").replace(/_/g, " ")}</span>
          <span className="spacer" />
          {claude.stopped ? (
            <button onClick={resumeClaude}>Resume</button>
          ) : (
            <button className="danger" onClick={stopClaude} data-testid="claude-stop">Stop</button>
          )}
        </div>
      )}
      <div className="prow">
        <span className="plabel">Permission</span>
        <select value={project.settings.permissionMode} onChange={(e) => run({ type: "project.setPermissionMode", mode: e.target.value as "ask" })}>
          <option value="readOnly">Read only</option>
          <option value="ask">Ask per change set</option>
          <option value="autoKeep">Auto-keep</option>
        </select>
      </div>
      {pending.length === 0 && <div className="muted small pad">No change sets waiting for review.</div>}
      {pending.map((cs) => (
        <div key={cs.id} className="changeset">
          <div className="cs-name">
            {cs.name} {cs.status === "open" && <em>(Claude is working…)</em>}
          </div>
          <div className="small muted">
            {cs.entries.length} edit(s) · layers: {cs.layerIds.map((id) => findLayer(id)?.name ?? editor.projectBefore(cs.id).compositions.flatMap((c) => c.layers).find((l) => l.id === id)?.name ?? id).join(", ") || "—"}
          </div>
          <div className="row">
            <button
              className={previewBefore === cs.id ? "active" : ""}
              onPointerDown={() => setUI({ previewBefore: cs.id })}
              onPointerUp={() => setUI({ previewBefore: null })}
              onPointerLeave={() => previewBefore === cs.id && setUI({ previewBefore: null })}
              title="Hold to see the project before this change set"
            >
              Hold: before
            </button>
            <button className="primary" onClick={() => editor.keepChangeSet(cs.id)}>Keep</button>
            <button
              onClick={() => {
                const r = editor.rejectChangeSet(cs.id);
                if (r.conflicts.length) toast(`Rejected. ${r.conflicts.length} layer(s) you also edited were restored to their pre-Claude state.`);
              }}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
      <button className="link" onClick={() => setUI({ dialog: "audit" })}>History of every command ({editor.audit.length})</button>
    </div>
  );
}

// ---------- dialogs ----------
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-bg" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CompForm({ isNew }: { isNew: boolean }) {
  const comp = activeComp(useProject());
  const [name, setName] = useState(isNew ? "Comp 2" : comp.name);
  const [w, setW] = useState(isNew ? 1920 : comp.width);
  const [h, setH] = useState(isNew ? 1080 : comp.height);
  const [fps, setFps] = useState(isNew ? 30 : comp.fps);
  const [dur, setDur] = useState(isNew ? 10 : comp.duration);
  const [transparent, setTransparent] = useState(isNew ? true : comp.background === null);
  const [bg, setBg] = useState(comp.background ?? "#000000");
  const [mode, setMode] = useState<"scaleToFit" | "keepLayout">("scaleToFit");
  const close = () => setUI({ dialog: null });
  const resized = !isNew && (w !== comp.width || h !== comp.height);
  const cacheMB = Math.round((w * h * fps * dur) / 1024 / 1024); // half-res RGBA frames = w*h bytes each
  const apply = () => {
    if (isNew) {
      const r = run({ type: "comp.create", comp: { name, width: w, height: h, fps, duration: dur, background: transparent ? null : bg } });
      if (r.ok) close();
      return;
    }
    const cmds: Parameters<typeof run>[0] = [{ type: "comp.update", name, fps, duration: dur, background: transparent ? null : bg }];
    if (resized) cmds.push({ type: "comp.resize", width: w, height: h, mode });
    if (run(cmds, { label: "Composition settings" }).ok) close();
  };
  return (
    <Modal title={isNew ? "New composition" : "Composition settings"} onClose={close}>
      <div className="form">
        <label>Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>
          Preset{" "}
          <select value="" onChange={(e) => { const p = COMP_PRESETS[e.target.value as keyof typeof COMP_PRESETS]; setW(p.width); setH(p.height); }}>
            <option value="" disabled>choose…</option>
            {Object.keys(COMP_PRESETS).map((k) => <option key={k}>{k}</option>)}
          </select>
        </label>
        <label>Width <input type="number" value={w} onChange={(e) => setW(Number(e.target.value))} /></label>
        <label>Height <input type="number" value={h} onChange={(e) => setH(Number(e.target.value))} /></label>
        <label>
          Frame rate{" "}
          <input list="fps" type="number" value={fps} onChange={(e) => setFps(Number(e.target.value))} />
          <datalist id="fps">{FPS_PRESETS.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <label>Duration (s) <input type="number" step="0.1" value={dur} onChange={(e) => setDur(Number(e.target.value))} /></label>
        <label><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent background</label>
        {!transparent && <label>Background <input type="color" value={bg.slice(0, 7)} onChange={(e) => setBg(e.target.value)} /></label>}
        {resized && (
          <label>
            On resize{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value as "scaleToFit")}>
              <option value="scaleToFit">Scale to fit</option>
              <option value="keepLayout">Keep layout (re-centre)</option>
            </select>
          </label>
        )}
        {!isNew && fps !== comp.fps && <div className="small muted">Keyframes keep their timing in seconds.</div>}
        {cacheMB > 1024 && <div className="small warn">A half-resolution frame cache for this comp would need about {cacheMB} MB, over the 1 GB cap; playback will cache only part of it.</div>}
      </div>
      <div className="modal-foot">
        <button onClick={close}>Cancel</button>
        <button className="primary" onClick={apply}>{isNew ? "Create" : "Apply"}</button>
      </div>
    </Modal>
  );
}

function ExportDialog() {
  const comp = activeComp(useProject());
  const [format, setFormat] = useState<ExportRequest["format"]>("prores4444");
  const [fps, setFps] = useState(comp.fps);
  const [width, setWidth] = useState(comp.width);
  const [job, setJob] = useState<{ id: string; out: string } | null>(null);
  const [st, setSt] = useState<{ status: string; done: number; total: number; error?: string; notes?: string[] } | null>(null);
  const close = () => setUI({ dialog: null });
  useEffect(() => {
    if (!job) return;
    const t = setInterval(async () => {
      const s = await exportStatus(job.id);
      setSt(s);
      if (s.status !== "running") clearInterval(t);
    }, 500);
    return () => clearInterval(t);
  }, [job]);
  return (
    <Modal title="Export" onClose={close}>
      <div className="form">
        <button className="preset" onClick={() => { setFormat("prores4444"); setFps(comp.fps); setWidth(comp.width); }}>
          <strong>Resolve-ready preset</strong>
          <span className="small muted">ProRes 4444 .mov with straight alpha (in Resolve: Clip Attributes › Alpha Mode › Straight)</span>
        </button>
        <label>
          Format{" "}
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportRequest["format"])}>
            <option value="prores4444">ProRes 4444 + alpha (.mov)</option>
            <option value="mp4">MP4 H.264 (no alpha, over black)</option>
            <option value="webm">WebM VP9 + alpha (.webm)</option>
            <option value="gif">GIF (1-bit transparency)</option>
            <option value="png">PNG sequence (RGBA)</option>
            <option value="fusion">Fusion composition for Resolve (.comp + .setting)</option>
          </select>
        </label>
        {format === "fusion" && (
          <div className="small muted">
            Editable Fusion nodes: shapes, text, images, transforms and keyframes. Layers Fusion can't express are rendered to PNG frames and loaded in
            their place; the list appears here after export. In Resolve: Fusion page › File › Import › Fusion Composition.
          </div>
        )}
        <label>Frame rate <input type="number" value={fps} onChange={(e) => setFps(Number(e.target.value))} /></label>
        <label>Width <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} /> × {Math.round((width / comp.width) * comp.height)}</label>
        {st && (
          <div className="progress">
            <div className="bar-fill" style={{ width: `${st.total ? (st.done / st.total) * 100 : 0}%` }} />
            <span>
              {st.status} {st.done}/{st.total} {st.error ?? ""}
            </span>
          </div>
        )}
        {job && st?.status === "done" && (
          <div className="small">
            Saved to {job.out}{" "}
            {native && <button onClick={() => native!.revealInFinder(job.out)}>Show in Finder</button>}
          </div>
        )}
        {job && st?.status === "done" && !!st.notes?.length && (
          <div className="small" data-testid="export-notes">
            <strong>Fusion notes</strong>
            <ul>
              {st.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="modal-foot">
        {job && st?.status === "running" ? (
          <button onClick={() => cancelExport(job.id)}>Cancel export</button>
        ) : (
          <button
            className="primary"
            onClick={async () => {
              try {
                setSt(null);
                setJob(await startExport({ format, fps, width }));
              } catch (e) {
                toast(`Export failed: ${(e as Error).message}`, "error");
              }
            }}
          >
            Export
          </button>
        )}
      </div>
    </Modal>
  );
}

function VersionsDialog() {
  const [versions, setVersions] = useState<string[] | null>(null);
  useEffect(() => {
    listVersions().then(setVersions);
  }, []);
  const close = () => setUI({ dialog: null });
  return (
    <Modal title="Version history" onClose={close}>
      <div className="form">
        <strong>Versions of this project</strong>
        <div className="list">
          {versions?.map((v) => (
            <button
              key={v}
              onClick={async () => {
                if (!window.confirm(`Restore ${v}? Your current state is saved as a version first.`)) return;
                await saveProject({ version: true });
                const p: Project = await loadVersion(v);
                editor.load(p);
                close();
              }}
            >
              {v.replace(".json", "")}
            </button>
          ))}
          {versions?.length === 0 && <span className="muted small">Versions are kept every 2 minutes while you work.</span>}
        </div>
      </div>
    </Modal>
  );
}

function AuditDialog() {
  useEditorRevision();
  const close = () => setUI({ dialog: null });
  return (
    <Modal title="Command history (audit trail)" onClose={close}>
      <div className="audit">
        {[...editor.audit].reverse().slice(0, 300).map((a, i) => (
          <div key={i} className={`audit-row ${a.ok ? "" : "fail"}`}>
            <span className="muted">{new Date(a.time).toLocaleTimeString()}</span>
            <span className={`src src-${a.source}`}>{a.source}</span>
            <code>{a.commands.map((c) => c.type).join(", ")}</code>
            {a.error && <span className="warn">{a.error}</span>}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ExportApproval() {
  const req = useUI((s) => s.exportRequest)!;
  const comp = activeComp(useProject());
  const fmt = { prores4444: "ProRes 4444 with alpha (.mov)", mp4: "MP4 H.264", png: "PNG sequence", webm: "WebM with alpha", gif: "GIF", fusion: "Fusion composition for Resolve" }[req.format] ?? req.format;
  return (
    <Modal title="Claude wants to export" onClose={() => answerExportRequest(false)}>
      <div className="form" data-testid="export-approval">
        <div>
          {comp.name}: {fmt}, {req.fps ?? comp.fps} fps, {req.width ?? comp.width} px wide.
        </div>
        <div className="small muted">The file is written to the renders folder. Saving the project happens first.</div>
      </div>
      <div className="modal-foot">
        <button onClick={() => answerExportRequest(false)}>Deny</button>
        <button className="primary" onClick={() => answerExportRequest(true)}>Allow export</button>
      </div>
    </Modal>
  );
}

// ---------- Brand kit (ED-15) ----------
const EMPTY_KIT: BrandKit = { name: "My brand", colors: [{ name: "Primary", color: "#f97316" }, { name: "Text", color: "#ffffff" }], fonts: [{ name: "Headline", family: "Inter, Helvetica Neue, Arial, sans-serif", weight: 700 }] };

function BrandDialog() {
  const project = useProject();
  const close = () => setUI({ dialog: null });
  const [kit, setKit] = useState<BrandKit>(() => structuredClone(project.brand ?? EMPTY_KIT));
  const [saved, setSaved] = useState<{ name: string }[]>([]);
  useEffect(() => {
    listLibrary("brand").then(setSaved);
  }, []);
  const edit = (fn: (k: BrandKit) => void) => setKit((k) => {
    const c = structuredClone(k);
    fn(c);
    return c;
  });
  const apply = () => {
    const r = run({ type: "brand.set", brand: kit }, { label: `Brand kit ${kit.name}` });
    if (r.ok) toast(`Brand kit "${kit.name}" is on this project`);
    return r.ok;
  };
  return (
    <Modal title="Brand kit" onClose={close}>
      <div className="form" data-testid="brand-dialog">
        <div className="small muted">
          Colours show as swatches next to every colour in the Inspector (Shift-click a swatch to link the property, so changing the kit recolours it). Fonts appear first in the font list.
        </div>
        <label>
          Load saved kit{" "}
          <select value="" onChange={(e) => loadBrandKit(e.target.value).then(setKit).catch((er) => toast(er.message, "error"))}>
            <option value="" disabled>{saved.length ? "choose…" : "none saved yet"}</option>
            {saved.map((k) => (
              <option key={k.name}>{k.name}</option>
            ))}
          </select>
        </label>
        <label>Name <input value={kit.name} onChange={(e) => edit((k) => (k.name = e.target.value))} /></label>
        <strong className="small">Colours</strong>
        {kit.colors.map((c, i) => (
          <div className="prow" key={i}>
            <input value={c.name} style={{ width: 120 }} onChange={(e) => edit((k) => (k.colors[i].name = e.target.value))} />
            <input type="color" value={c.color.slice(0, 7)} onChange={(e) => edit((k) => (k.colors[i].color = e.target.value))} />
            <code className="small">{c.color}</code>
            <button onClick={() => edit((k) => k.colors.splice(i, 1))}>✕</button>
          </div>
        ))}
        <button onClick={() => edit((k) => k.colors.push({ name: `Colour ${k.colors.length + 1}`, color: "#888888" }))}>+ Colour</button>
        <strong className="small">Fonts</strong>
        {kit.fonts.map((fo, i) => (
          <div className="prow" key={i}>
            <input value={fo.name} style={{ width: 100 }} onChange={(e) => edit((k) => (k.fonts[i].name = e.target.value))} />
            <input value={fo.family} style={{ width: 200 }} onChange={(e) => edit((k) => (k.fonts[i].family = e.target.value))} />
            <input type="number" value={fo.weight} step={100} min={100} max={900} style={{ width: 60 }} onChange={(e) => edit((k) => (k.fonts[i].weight = Number(e.target.value)))} />
            <button onClick={() => edit((k) => k.fonts.splice(i, 1))}>✕</button>
          </div>
        ))}
        <button onClick={() => edit((k) => k.fonts.push({ name: "Body", family: "Inter, Helvetica Neue, Arial, sans-serif", weight: 400 }))}>+ Font</button>
      </div>
      <div className="modal-foot">
        {project.brand && <button onClick={() => (run({ type: "brand.set", brand: null }), close())}>Remove from project</button>}
        <button onClick={() => saveBrandKit(kit).then(() => toast(`Saved kit "${kit.name}" to library/brand-kits`)).catch((e) => toast(e.message, "error"))}>Save to library</button>
        <button className="primary" onClick={() => apply() && close()}>Use in this project</button>
      </div>
    </Modal>
  );
}

// ---------- Template fields (ED-16) ----------
function TemplateDialog() {
  const project = useProject();
  useEditorRevision();
  const comp = activeComp(project);
  const close = () => setUI({ dialog: null });
  const fields = comp.template?.fields ?? [];
  const [layerId, setLayerId] = useState(comp.layers[0]?.id ?? "");
  const layer = comp.layers.find((l) => l.id === layerId);
  const paths = layer ? [...(layer.type === "text" ? ["text"] : []), ...listProps(layer).filter((p) => typeof p.prop.value !== "object" || Array.isArray(p.prop.value)).map((p) => p.path)] : [];
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [templates, setTemplates] = useState<{ name: string }[]>([]);
  const [tplName, setTplName] = useState(comp.name);
  useEffect(() => {
    listLibrary("template").then(setTemplates);
  }, []);
  const current = (f: TemplateField): string | number | Vec2 => {
    const l = comp.layers.find((x) => x.id === f.layerId);
    if (!l) return "";
    if (f.kind === "text") return l.type === "text" ? l.text : "";
    const p = getProp(l, f.path);
    return (p ? (p.keyframes?.length ? p.keyframes[0].v : p.value) : "") as string | number | Vec2;
  };
  const fill = (f: TemplateField, v: unknown) => run({ type: "template.fill", values: { [f.id]: v } }, { coalesceKey: `tpl-${f.id}`, label: `Fill ${f.name}` });
  return (
    <Modal title={`Template: ${comp.name}`} onClose={close}>
      <div className="form" data-testid="template-dialog">
        <strong className="small">Fields</strong>
        {fields.length === 0 && <div className="small muted">Name the parts someone should change when reusing this comp, e.g. the person's name or the accent colour.</div>}
        {fields.map((f) => {
          const v = current(f);
          return (
            <div className="prow" key={f.id}>
              <input value={f.name} style={{ width: 110 }} title="Field name" onChange={(e) => run({ type: "template.updateField", fieldId: f.id, name: e.target.value || f.name }, { coalesceKey: `tplname-${f.id}` })} />
              {f.kind === "text" && <input value={String(v)} style={{ width: 200 }} onChange={(e) => fill(f, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />}
              {f.kind === "color" && <input type="color" value={String(v).slice(0, 7)} onChange={(e) => fill(f, e.target.value)} />}
              {f.kind === "number" && <input type="number" value={Number(v)} style={{ width: 80 }} onChange={(e) => fill(f, Number(e.target.value))} />}
              {f.kind === "vec2" && (
                <>
                  <input type="number" value={(v as Vec2)[0]} style={{ width: 70 }} onChange={(e) => fill(f, [Number(e.target.value), (v as Vec2)[1]])} />
                  <input type="number" value={(v as Vec2)[1]} style={{ width: 70 }} onChange={(e) => fill(f, [(v as Vec2)[0], Number(e.target.value)])} />
                </>
              )}
              <button title="Remove field" onClick={() => run({ type: "template.removeField", fieldId: f.id })}>✕</button>
            </div>
          );
        })}
        <div className="prow">
          <select value={layerId} onChange={(e) => (setLayerId(e.target.value), setPath(""))}>
            {comp.layers.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <select value={path} onChange={(e) => setPath(e.target.value)}>
            <option value="">property…</option>
            {paths.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <input placeholder="Field name" value={name} style={{ width: 110 }} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button
            disabled={!path || !name.trim()}
            onClick={() => {
              if (run({ type: "template.addField", layerId, path, name }).ok) setName("");
            }}
          >
            + Field
          </button>
        </div>
        <strong className="small">Library</strong>
        <div className="prow">
          <input value={tplName} style={{ width: 160 }} onChange={(e) => setTplName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button onClick={() => saveAsTemplate(tplName).then(() => (toast(`Saved template "${tplName}"`), listLibrary("template").then(setTemplates))).catch((e) => toast(e.message, "error"))}>Save project as template</button>
        </div>
        <div className="prow">
          <span className="small">New project from</span>
          <select
            value=""
            onChange={(e) => {
              const t = e.target.value;
              newFromTemplate(t, t).then((n) => (toast(`Opened ${n}`), close())).catch((er) => toast(er.message, "error"));
            }}
          >
            <option value="" disabled>{templates.length ? "choose a template…" : "no templates yet"}</option>
            {templates.map((t) => (
              <option key={t.name}>{t.name}</option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useUI((s) => s.dialog);
  const exportRequest = useUI((s) => s.exportRequest);
  if (exportRequest) return <ExportApproval />;
  if (dialog === "comp") return <CompForm isNew={false} />;
  if (dialog === "newComp") return <CompForm isNew />;
  if (dialog === "export") return <ExportDialog />;
  if (dialog === "versions") return <VersionsDialog />;
  if (dialog === "audit") return <AuditDialog />;
  if (dialog === "brand") return <BrandDialog />;
  if (dialog === "template") return <TemplateDialog />;
  return null;
}
