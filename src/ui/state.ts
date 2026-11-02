import { useSyncExternalStore } from "react";
import { Editor, type DispatchOptions } from "../core/editor";
import type { Command } from "../core/commands";
import { makeProject } from "../core/factory";
import { lowerThirdProject } from "../core/samples";
import type { Composition, Layer, Project } from "../core/types";

// ---------- the editor (project + history) ----------
export const editor = new Editor(lowerThirdProject());

export function useProject(): Project {
  return useSyncExternalStore((cb) => editor.subscribe(cb), () => editor.project);
}
export function useEditorRevision(): number {
  return useSyncExternalStore((cb) => editor.subscribe(cb), () => editor.revision);
}
export function activeComp(p: Project = editor.project): Composition {
  return p.compositions.find((c) => c.id === p.activeCompId) ?? p.compositions[0];
}
export function findLayer(id: string, p: Project = editor.project): Layer | undefined {
  return activeComp(p).layers.find((l) => l.id === id);
}

// ---------- UI state (not part of the project, not undoable) ----------
export type Tool = "select" | "pen" | "rect" | "ellipse" | "text";
export interface KeySel {
  layerId: string;
  path: string;
  kfId: string;
}
export interface UIState {
  time: number;
  playing: boolean;
  selection: string[];
  keys: KeySel[];
  tool: Tool;
  expanded: Record<string, boolean>;
  graph: { layerId: string; path: string } | null;
  /** Change set being previewed as "before". */
  previewBefore: string | null;
  toast: { text: string; kind: "info" | "error" } | null;
  dialog: null | "comp" | "newComp" | "export" | "versions" | "audit";
  projectName: string;
  saveState: "saved" | "saving" | "dirty" | "offline";
  showReference: boolean;
  timelineZoom: number; // px per second
  /** Claude connection (CL-07). */
  claude: { agents: number; bridge: "connecting" | "up" | "down"; action: string | null; stopped: boolean };
  /** Claude asked to export; waiting for my approval. */
  exportRequest: { format: string; fps?: number; width?: number } | null;
}

let ui: UIState = {
  time: 1.5,
  playing: false,
  selection: [],
  keys: [],
  tool: "select",
  expanded: {},
  graph: null,
  previewBefore: null,
  toast: null,
  dialog: null,
  projectName: "lower-third",
  saveState: "dirty",
  showReference: true,
  timelineZoom: 120,
  claude: { agents: 0, bridge: "connecting", action: null, stopped: false },
  exportRequest: null,
};
const uiListeners = new Set<() => void>();
export function getUI() {
  return ui;
}
export function setUI(patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)) {
  const p = typeof patch === "function" ? patch(ui) : patch;
  ui = { ...ui, ...p };
  uiListeners.forEach((l) => l());
}
export function useUI<T>(sel: (s: UIState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      uiListeners.add(cb);
      return () => uiListeners.delete(cb);
    },
    () => sel(ui),
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, kind: "info" | "error" = "info") {
  setUI({ toast: { text, kind } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setUI({ toast: null }), kind === "error" ? 5000 : 2500);
}

/** Run user commands; shows errors instead of throwing. */
export function run(cmds: Command | Command[], opts: DispatchOptions = {}) {
  const r = editor.dispatch(cmds, { source: "user", ...opts });
  if (!r.ok) toast(r.error ?? "Command failed", "error");
  return r;
}

export function snapTime(t: number): number {
  const c = activeComp();
  const f = Math.round(Math.max(0, Math.min(c.duration, t)) * c.fps);
  return Math.min(f, Math.round(c.duration * c.fps) - 1) / c.fps;
}
export function setTime(t: number) {
  setUI({ time: snapTime(t) });
}

export function newBlankProject() {
  editor.load(makeProject("Untitled"));
  setUI({ selection: [], keys: [], time: 0, projectName: `project-${new Date().toISOString().slice(0, 10)}` });
}

// Prune stale selection after undo/redo/rejects.
editor.subscribe(() => {
  const comp = activeComp();
  const ids = new Set(comp.layers.map((l) => l.id));
  if (ui.selection.some((id) => !ids.has(id))) setUI({ selection: ui.selection.filter((id) => ids.has(id)) });
  if (ui.time >= comp.duration) setUI({ time: snapTime(ui.time) });
  if (ui.saveState === "saved") setUI({ saveState: "dirty" });
});
