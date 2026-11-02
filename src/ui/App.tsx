import { useEffect, useRef } from "react";
import type { Asset } from "../core/types";
import { newId } from "../core/id";
import { compContains } from "../core/commands";
import { lowerThirdProject } from "../core/samples";
import { listProjects, saveProject, uploadAsset, openProject } from "./api";
import { startBridge } from "./bridge-client";
import { Inspector } from "./Inspector";
import { ClaudePanel, Dialogs } from "./Panels";
import { activeComp, editor, getUI, newBlankProject, run, setTime, setUI, toast, useEditorRevision, useProject, useUI, type Tool } from "./state";
import { Timeline } from "./Timeline";
import { Viewer } from "./Viewer";
import { native, toFile } from "./native";

const TOOLS: [Tool, string, string][] = [
  ["select", "V", "Select / move"],
  ["pen", "P", "Pen"],
  ["rect", "R", "Rectangle"],
  ["ellipse", "E", "Ellipse"],
  ["text", "T", "Text"],
];

async function importFiles(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
    const isImage = /^image\/(png|jpeg|svg\+xml)$/.test(file.type) || /\.(png|jpe?g|svg)$/i.test(file.name);
    if (!isVideo && !isImage) {
      toast(`Unsupported file: ${file.name} (SVG, PNG, JPG, or a video as reference)`, "error");
      continue;
    }
    try {
      const url = URL.createObjectURL(file);
      const dims = await new Promise<{ w: number; h: number; d?: number }>((res, rej) => {
        if (isVideo) {
          const v = document.createElement("video");
          v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
          v.onerror = () => rej(new Error("Cannot read video (try MP4/H.264)"));
          v.src = url;
        } else {
          const i = new Image();
          i.onload = () => res({ w: i.naturalWidth || 512, h: i.naturalHeight || 512 });
          i.onerror = () => rej(new Error("Cannot read image"));
          i.src = url;
        }
      });
      URL.revokeObjectURL(url);
      const src = await uploadAsset(file);
      const asset: Asset = { id: newId("asset"), name: file.name, kind: isVideo ? "video" : file.name.toLowerCase().endsWith(".svg") ? "svg" : "image", src, width: dims.w, height: dims.h, ...(dims.d ? { duration: dims.d } : {}) };
      const comp = activeComp();
      const r = run(
        [
          { type: "asset.add", asset },
          {
            type: "layer.add",
            layerType: isVideo ? "reference" : "image",
            index: isVideo ? comp.layers.length : 0,
            opts: { name: file.name, assetId: asset.id, width: dims.w, height: dims.h, position: [comp.width / 2, comp.height / 2] },
          },
        ],
        { label: `Import ${file.name}` },
      );
      if (r.ok) {
        const id = (r.results[1] as { layerId: string }).layerId;
        if (isVideo) {
          // fit the reference video to the comp
          const s = Math.min(comp.width / dims.w, comp.height / dims.h) * 100;
          run({ type: "prop.set", layerId: id, path: "transform.scale", value: [s, s] }, { coalesceKey: `imp-${id}` });
          toast("Reference video added. It is shown here but left out of every export.");
        }
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
  switch (id) {
    case "new-project":
      if (window.confirm("Start a new empty project? The current one stays saved.")) newBlankProject();
      return;
    case "open-project":
      return setUI({ dialog: "versions" });
    case "sample":
      editor.load(lowerThirdProject());
      return setUI({ projectName: "lower-third-sample" });
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
  const fileRef = useRef<HTMLInputElement>(null);

  // Open the last project on start, else keep the sample.
  useEffect(() => {
    let last: string | null = null;
    try {
      last = localStorage.getItem("mge:last");
    } catch {
      /* ignore */
    }
    if (last)
      listProjects()
        .then((list) => list.some((p) => p.name === last) && openProject(last!))
        .catch(() => undefined);
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
    native?.setTitle(`${projectName} — ${comp.name}`, saveState !== "saved");
  }, [projectName, comp.name, saveState]);
  useEffect(() => {
    native?.setMenuState({ canUndo: editor.canUndo, canRedo: editor.canRedo, hasSelection: selection.length > 0 });
  });

  // Playback: real-time, frame-snapped, loops.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = getUI().time;
    const tick = (now: number) => {
      const c = activeComp();
      acc += (now - last) / 1000;
      last = now;
      if (acc >= c.duration) acc = 0;
      const frameTime = Math.floor(acc * c.fps) / c.fps; // frame-accurate, like export
      if (frameTime !== getUI().time) setUI({ time: frameTime });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
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
        <input
          className="pname-input"
          value={projectName}
          title="Project folder name (projects/<name>)"
          onChange={(e) => setUI({ projectName: e.target.value.replace(/[^a-zA-Z0-9 _.-]/g, "_"), saveState: "dirty" })}
        />
        <button onClick={() => setUI({ dialog: "versions" })}>Open</button>
        <button onClick={() => { if (window.confirm("Start a new empty project? The current one stays saved.")) newBlankProject(); }}>New</button>
        <button onClick={() => { editor.load(lowerThirdProject()); setUI({ projectName: "lower-third-sample" }); }} title="Load the sample lower third">Sample</button>
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
        <input ref={fileRef} type="file" multiple hidden accept=".svg,.png,.jpg,.jpeg,.mp4,.mov,.webm" onChange={(e) => e.target.files && importFiles(e.target.files)} />
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
