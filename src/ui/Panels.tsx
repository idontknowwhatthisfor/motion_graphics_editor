import { useEffect, useState } from "react";
import { COMP_PRESETS, FPS_PRESETS } from "../core/factory";
import type { Project } from "../core/types";
import { cancelExport, exportStatus, listProjects, listVersions, loadVersion, openProject, saveProject, startExport, type ExportRequest } from "./api";
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
  const [st, setSt] = useState<{ status: string; done: number; total: number; error?: string } | null>(null);
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
          </select>
        </label>
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
  const [projects, setProjects] = useState<{ name: string }[]>([]);
  useEffect(() => {
    listVersions().then(setVersions);
    listProjects().then(setProjects);
  }, []);
  const close = () => setUI({ dialog: null });
  return (
    <Modal title="Projects and version history" onClose={close}>
      <div className="form">
        <strong>Open project</strong>
        <div className="list">
          {projects.map((p) => (
            <button key={p.name} onClick={async () => (await openProject(p.name)) && close()}>{p.name}</button>
          ))}
          {projects.length === 0 && <span className="muted small">No saved projects yet.</span>}
        </div>
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
  const fmt = { prores4444: "ProRes 4444 with alpha (.mov)", mp4: "MP4 H.264", png: "PNG sequence", webm: "WebM with alpha", gif: "GIF" }[req.format] ?? req.format;
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

export function Dialogs() {
  const dialog = useUI((s) => s.dialog);
  const exportRequest = useUI((s) => s.exportRequest);
  if (exportRequest) return <ExportApproval />;
  if (dialog === "comp") return <CompForm isNew={false} />;
  if (dialog === "newComp") return <CompForm isNew />;
  if (dialog === "export") return <ExportDialog />;
  if (dialog === "versions") return <VersionsDialog />;
  if (dialog === "audit") return <AuditDialog />;
  return null;
}
