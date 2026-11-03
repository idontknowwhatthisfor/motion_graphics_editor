import { useEffect, useRef, useState } from "react";
import type { Asset } from "../core/types";
import type { MakeLayerOpts } from "../core/factory";
import { newId } from "../core/id";
import { compContains } from "../core/commands";
import { goHome, openProject, openSample, renameProject, saveProject, uploadAsset } from "./api";
import { Home } from "./Home";
import { startBridge } from "./bridge-client";
import { Inspector } from "./Inspector";
import { ClaudePanel, Dialogs } from "./Panels";
import { activeComp, editor, getUI, run, setTime, setUI, toast, useEditorRevision, useProject, useUI, type Tool } from "./state";
import { Timeline } from "./Timeline";
import { Viewer } from "./Viewer";
import { native, toFile } from "./native";
import { playAudio } from "./audio";

const TOOLS: [Tool, string, string][] = [
  ["select", "V", "Select / move"],
  ["pen", "P", "Pen"],
  ["rect", "R", "Rectangle"],
  ["ellipse", "E", "Ellipse"],
  ["text", "T", "Text"],
];

async function importFiles(files: FileList | File[]) {
  if (getUI().screen !== "editor") return toast("Open or create a project first, then import", "error");
  for (const file of Array.from(files)) {
    const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
    const isAudio = /^audio\//.test(file.type) || /\.(wav|mp3|m4a|aac|aif|aiff)$/i.test(file.name);
    const isImage = /^image\/(png|jpeg|svg\+xml)$/.test(file.type) || /\.(png|jpe?g|svg)$/i.test(file.name);
    if (!isVideo && !isImage && !isAudio) {
      toast(`Unsupported file: ${file.name} (SVG, PNG, JPG, MP4, MOV, WebM, WAV, MP3)`, "error");
      continue;
    }
    try {
      const url = URL.createObjectURL(file);
      const dims = await new Promise<{ w: number; h: number; d?: number }>((res, rej) => {
        if (isVideo || isAudio) {
          const v = document.createElement(isVideo ? "video" : "audio");
          v.onloadedmetadata = () => res({ w: (v as HTMLVideoElement).videoWidth || 0, h: (v as HTMLVideoElement).videoHeight || 0, d: v.duration });
          // Chrome cannot preview every codec (e.g. ProRes); the export still reads it with FFmpeg.
          v.onerror = () => (isVideo ? res({ w: 1920, h: 1080 }) : rej(new Error("Cannot read this audio file")));
          v.src = url;
        } else {
          const i = new Image();
          i.onload = () => res({ w: i.naturalWidth || 512, h: i.naturalHeight || 512 });
          i.onerror = () => rej(new Error("Cannot read image"));
          i.src = url;
        }
      });
      URL.revokeObjectURL(url);
      const { src, hasAudio } = await uploadAsset(file);
      const kind: Asset["kind"] = isVideo ? "video" : isAudio ? "audio" : file.name.toLowerCase().endsWith(".svg") ? "svg" : "image";
      const asset: Asset = { id: newId("asset"), name: file.name, kind, src, width: dims.w, height: dims.h, ...(dims.d && Number.isFinite(dims.d) ? { duration: dims.d } : {}) };
      const comp = activeComp();
      const mediaDur = dims.d && Number.isFinite(dims.d) && (isVideo || isAudio) ? dims.d : undefined;
      // A clip longer than the comp stretches the comp to fit it, in the same undo step.
      const stretch = mediaDur !== undefined && mediaDur > comp.duration ? Math.min(3600, mediaDur) : undefined;
      const outPoint = mediaDur !== undefined ? Math.min(stretch ?? comp.duration, mediaDur) : comp.duration;
      // A video with sound also gets an audio layer that plays the same file, linked so they stay in sync.
      const withSound = isVideo && hasAudio === true;
      const ids = { main: newId("layer"), sound: newId("layer"), link: newId("link") };
      // A video that is not the comp size is scaled to fit inside it (the whole frame stays visible).
      const fit = isVideo && dims.w && dims.h && (dims.w !== comp.width || dims.h !== comp.height) ? Math.min(comp.width / dims.w, comp.height / dims.h) * 100 : undefined;
      const r = run(
        [
          { type: "asset.add", asset },
          ...(stretch !== undefined ? ([{ type: "comp.update", compId: comp.id, duration: stretch }] as const) : []),
          {
            type: "layer.add",
            layerType: isVideo ? "video" : isAudio ? "audio" : "image",
            index: isVideo || isAudio ? comp.layers.length : 0,
            opts: { id: ids.main, name: file.name, assetId: asset.id, width: dims.w, height: dims.h, position: [comp.width / 2, comp.height / 2], outPoint } as MakeLayerOpts,
          },
          ...(fit !== undefined ? [{ type: "prop.set" as const, layerId: ids.main, path: "transform.scale", value: [fit, fit] as [number, number] }] : []),
          ...(withSound
            ? ([
                { type: "layer.add", layerType: "audio", index: comp.layers.length + 1, opts: { id: ids.sound, name: `${file.name} (sound)`, assetId: asset.id, outPoint } as MakeLayerOpts },
                { type: "layer.update", layerId: ids.main, patch: { linkId: ids.link } },
                { type: "layer.update", layerId: ids.sound, patch: { linkId: ids.link } },
              ] as const)
            : []),
        ],
        { label: `Import ${file.name}` },
      );
      if (r.ok) {
        const id = ids.main;
        if (withSound) toast("Video and its sound added as linked layers. Unlink them with the link icon in the timeline.");
        else if (isVideo) toast("Video added. It is exported; switch it to Reference in the Inspector to keep it out of exports.");
        if (isAudio) toast("Audio added. Select it and use Detect beats to drop beat markers.");
        if (stretch !== undefined) toast(`Composition lengthened to ${stretch.toFixed(2)} s to fit ${file.name}.`);
        setUI({ selection: [id] });
      }
    } catch (e) {
      toast(`${file.name}: ${(e as Error).message}`, "error");
    }
  }
}

/** Move the selected layers into a new comp and put a nested comp layer in their place (ED-02). */
function precompose() {
  const ui = getUI();
  if (!ui.selection.length) return toast("Select layers to precompose", "error");
  const r = run({ type: "comp.precompose", layerIds: ui.selection });
  if (r.ok) setUI({ selection: [(r.results[0] as { layerId: string }).layerId] });
}

const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

function addLayer(type: "shape" | "text" | "solid" | "null") {
  const r = run({ type: "layer.add", layerType: type, opts: type === "solid" ? { color: "#1d4ed8" } : {} });
  if (r.ok) setUI({ selection: [(r.results[0] as { layerId: string }).layerId] });
}

/** Commands from the Mac app's native menus (ED-26). */
function menuCommand(id: string) {
  const ui = getUI();
  // On the project list only the project commands apply.
  if (ui.screen === "home" && !["new-project", "open-project", "sample", "flush-save"].includes(id)) return;
  switch (id) {
    case "new-project":
    case "open-project":
      return void goHome();
    case "sample":
      return void openSample();
    case "versions":
      return setUI({ dialog: "versions" });
    case "save-version":
      return void saveProject({ version: true }).then((ok) => ok && toast("Saved"));
    case "flush-save":
      return void (getUI().saveState === "saved" ? Promise.resolve(true) : saveProject()).finally(() => native?.flushed());
    case "export":
      return setUI({ dialog: "export" });
    case "undo":
      // Text fields keep their own undo.
      if (isTyping()) return void document.execCommand("undo");
      return editor.undo();
    case "redo":
      if (isTyping()) return void document.execCommand("redo");
      return editor.redo();
    case "duplicate":
      return ui.selection.forEach((l) => run({ type: "layer.duplicate", layerId: l }));
    case "split":
      return ui.selection.forEach((l) => run({ type: "layer.split", layerId: l, t: ui.time }));
    case "delete":
      if (ui.selection.length) run({ type: "layer.delete", layerIds: ui.selection });
      return;
    case "new-comp":
      return setUI({ dialog: "newComp" });
    case "template":
      return setUI({ dialog: "template" });
    case "brand":
      return setUI({ dialog: "brand" });
    case "comp-settings":
      return setUI({ dialog: "comp" });
    case "precompose":
      return precompose();
    case "marker":
      return void run({ type: "marker.add", t: ui.time, label: "" });
    case "play":
      return setUI({ playing: !ui.playing });
    case "toggle-ref":
      return setUI({ showReference: !ui.showReference });
    default:
      if (id.startsWith("add:")) addLayer(id.slice(4) as "shape");
  }
}

/**
 * The project (folder) name. Typing edits a draft; Enter or clicking away
 * renames once, Esc cancels. Renaming on every keystroke made the autosave
 * leave a folder for each half-typed name.
 */
function ProjectNameField() {
  const projectName = useUI((s) => s.projectName);
  const [draft, setDraft] = useState(projectName);
  const cancelled = useRef(false);
  useEffect(() => setDraft(projectName), [projectName]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return setDraft(projectName);
    }
    const to = draft.trim().replace(/^\.+/, "").slice(0, 80);
    if (!to || to === projectName) return setDraft(projectName);
    renameProject(to).then((ok) => !ok && setDraft(getUI().projectName));
  };
  return (
    <input
      className="pname-input"
      value={draft}
      title="Project folder name (projects/<name>). Enter to rename, Esc to cancel."
      onChange={(e) => setDraft(e.target.value.replace(/[^a-zA-Z0-9 _.-]/g, "_"))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancelled.current = true;
        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );
}

export function App() {
  const project = useProject();
  useEditorRevision();
  const comp = activeComp(project);
  const tool = useUI((s) => s.tool);
  const playing = useUI((s) => s.playing);
  const saveState = useUI((s) => s.saveState);
  const toastMsg = useUI((s) => s.toast);
  const projectName = useUI((s) => s.projectName);
  const showReference = useUI((s) => s.showReference);
  const selection = useUI((s) => s.selection);
  const screen = useUI((s) => s.screen);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    startBridge();
    if (!native) return;
    const offs = [
      native.onMenu(menuCommand),
      native.onOpenFiles((files) => importFiles(files.map(toFile))),
      native.onOpenProject((name) => {
        // Save what is open first, then switch.
        saveProject().finally(() => openProject(name).then((ok) => (ok ? toast(`Opened ${name}`) : toast(`Cannot open ${name}`, "error"))));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Mac app: window title, the "edited" dot, and which menu items are enabled.
  useEffect(() => {
    native?.setTitle(screen === "home" ? "Projects" : `${projectName} — ${comp.name}`, screen !== "home" && saveState !== "saved");
  }, [screen, projectName, comp.name, saveState]);
  useEffect(() => {
    native?.setMenuState({ canUndo: editor.canUndo, canRedo: editor.canRedo, hasSelection: selection.length > 0 });
  });

  // Playback: real-time, frame-snapped, loops.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = getUI().time;
    let shown = acc;
    const tick = (now: number) => {
      const c = activeComp();
      // The playhead was moved during playback: continue from there.
      if (getUI().time !== shown) {
        acc = getUI().time;
        stopAudio();
        stopAudio = playAudio(editor.project, c, acc);
      }
      acc += (now - last) / 1000;
      last = now;
      if (acc >= c.duration) {
        acc = 0;
        stopAudio();
        stopAudio = playAudio(editor.project, c, 0);
      }
      const frameTime = Math.floor(acc * c.fps) / c.fps; // frame-accurate, like export
      if (frameTime !== getUI().time) setUI({ time: frameTime });
      shown = frameTime;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    let stopAudio = playAudio(editor.project, activeComp(), acc);
    return () => {
      stopAudio();
      cancelAnimationFrame(raf);
      setTime(getUI().time);
    };
  }, [playing]);

  // Autosave every 5 s when changed (PRD: lose at most 30 s after a crash).
  useEffect(() => {
    const t = setInterval(() => {
      const s = getUI().saveState;
      if (s === "dirty" || s === "offline") saveProject();
    }, 5000);
    return () => clearInterval(t);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getUI().screen !== "editor") return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const mod = e.metaKey || e.ctrlKey;
      const ui = getUI();
      const c = activeComp();
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveProject({ version: true }).then((ok) => ok && toast("Saved"));
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (e.shiftKey) ui.selection.forEach((id) => run({ type: "layer.split", layerId: id, t: ui.time }));
        else ui.selection.forEach((id) => run({ type: "layer.duplicate", layerId: id }));
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        precompose();
        return;
      }
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setUI({ dialog: "comp" });
        return;
      }
      if (mod) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          setUI({ playing: !ui.playing });
          break;
        case "ArrowLeft":
          setTime(ui.time - (e.shiftKey ? 10 : 1) / c.fps);
          break;
        case "ArrowRight":
          setTime(ui.time + (e.shiftKey ? 10 : 1) / c.fps);
          break;
        case "Home":
          setTime(0);
          break;
        case "End":
          setTime(c.duration);
          break;
        case "Delete":
        case "Backspace":
          if (ui.keys.length) {
            const byProp = new Map<string, string[]>();
            ui.keys.forEach((k) => byProp.set(`${k.layerId}|${k.path}`, [...(byProp.get(`${k.layerId}|${k.path}`) ?? []), k.kfId]));
            run([...byProp].map(([k, ids]) => ({ type: "keyframe.remove" as const, layerId: k.split("|")[0], path: k.split("|")[1], keyframeIds: ids })));
            setUI({ keys: [] });
          } else if (ui.selection.length) run({ type: "layer.delete", layerIds: ui.selection });
          break;
        case "m":
        case "M":
          run({ type: "marker.add", t: ui.time, label: "" });
          break;
        case "Escape":
          setUI({ selection: [], keys: [] });
          break;
        default: {
          const t = TOOLS.find(([, k]) => k.toLowerCase() === e.key.toLowerCase());
          if (t) setUI({ tool: t[0] });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (screen === "home")
    return (
      <>
        <Home />
        {toastMsg && <div className={`toast ${toastMsg.kind}`}>{toastMsg.text}</div>}
      </>
    );

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <strong className="brand">◆ Motion</strong>
        <ProjectNameField />
        <button onClick={() => goHome()} title="All projects (saves this one first)">Projects</button>
        <button onClick={() => setUI({ dialog: "versions" })} title="Version history of this project">Versions</button>
        <span className="sep" />
        <select value={comp.id} onChange={(e) => run({ type: "comp.setActive", compId: e.target.value })} title="Composition">
          {project.compositions.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button onClick={() => setUI({ dialog: "comp" })} title="Composition settings (Cmd+K)">Settings</button>
        <button onClick={() => setUI({ dialog: "newComp" })}>+ Comp</button>
        <button onClick={() => setUI({ dialog: "template" })} title="Template fields and the template library">Template</button>
        <button onClick={() => setUI({ dialog: "brand" })} title="Brand kit: colours and fonts">Brand</button>
        <span className="sep" />
        {TOOLS.map(([t, k, label]) => (
          <button key={t} className={tool === t ? "active" : ""} title={`${label} (${k})`} onClick={() => setUI({ tool: t })}>
            {{ select: "↖", pen: "✒", rect: "▭", ellipse: "◯", text: "T" }[t]}
          </button>
        ))}
        <span className="sep" />
        <select
          value=""
          style={{ maxWidth: 110 }}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "precompose") return precompose();
            if (!v.startsWith("precomp:")) return addLayer(v as "solid");
            const r = run({ type: "layer.add", layerType: "precomp", opts: { compId: v.slice(8) } });
            if (r.ok) setUI({ selection: [(r.results[0] as { layerId: string }).layerId] });
          }}
        >
          <option value="" disabled>+ Layer</option>
          <option value="shape">Shape</option>
          <option value="text">Text</option>
          <option value="solid">Solid</option>
          <option value="null">Null</option>
          {project.compositions
            .filter((c) => !compContains(project, c.id, comp.id))
            .map((c) => (
              <option key={c.id} value={`precomp:${c.id}`}>Nested comp: {c.name}</option>
            ))}
          <option value="precompose" disabled={!selection.length}>Precompose selection</option>
        </select>
        <button onClick={() => (native ? native.pick("import") : fileRef.current?.click())} title="Import SVG, PNG, JPG, or a reference video (or drag files onto the window)">Import</button>
        <input ref={fileRef} type="file" multiple hidden accept=".svg,.png,.jpg,.jpeg,.mp4,.mov,.webm,.m4v,.wav,.mp3,.m4a,.aac,.aif,.aiff" onChange={(e) => e.target.files && importFiles(e.target.files)} />
        <label className="small" title="Show reference video layers (never exported)"><input type="checkbox" checked={showReference} onChange={(e) => setUI({ showReference: e.target.checked })} /> Ref</label>
        <span className="spacer" />
        <button disabled={!editor.canUndo} onClick={() => editor.undo()} title="Undo (Cmd+Z)">↶</button>
        <button disabled={!editor.canRedo} onClick={() => editor.redo()} title="Redo (Cmd+Shift+Z)">↷</button>
        <span className={`save save-${saveState}`}>{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "offline" ? "Not saved (server offline)" : "Unsaved"}</span>
        <button className="primary" onClick={() => setUI({ dialog: "export" })}>Export</button>
      </header>
      <main className="main">
        <Viewer />
        <aside className="side">
          <Inspector />
          <ClaudePanel />
        </aside>
      </main>
      <Timeline />
      <Dialogs />
      {toastMsg && <div className={`toast ${toastMsg.kind}`}>{toastMsg.text}</div>}
    </div>
  );
}
