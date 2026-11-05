/** Talks to the local project store (scripts/vite-project-store.ts). */
import { makeProject } from "../core/factory";
import { parseProject, serializeProject } from "../core/project-io";
import { lowerThirdProject } from "../core/samples";
import type { Asset, BrandKit, Project } from "../core/types";
import { editor, getUI, setUI, toast } from "./state";

export function assetUrl(a: Asset): string {
  if (a.src.startsWith("data:") || a.src.startsWith("blob:") || a.src.startsWith("http")) return a.src;
  return `/projects/${encodeURIComponent(getUI().projectName)}/${a.src}`;
}

export async function listProjects(): Promise<{ name: string; modified: number }[]> {
  const r = await fetch("/api/projects");
  return r.ok ? r.json() : [];
}

export async function saveProject(opts: { version?: boolean } = {}): Promise<boolean> {
  // On the project list the editor holds no open project (at launch it is the
  // built-in sample), so there is nothing to save and no folder to overwrite.
  if (getUI().screen !== "editor") return true;
  const name = getUI().projectName;
  setUI({ saveState: "saving" });
  const rev = editor.revision;
  try {
    const r = await fetch(`/api/project?name=${encodeURIComponent(name)}${opts.version ? "&version=1" : ""}`, {
      method: "PUT",
      body: serializeProject(editor.project),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    setUI({ saveState: editor.revision === rev ? "saved" : "dirty", diskName: name });
    try {
      localStorage.setItem("mge:last", name);
    } catch {
      /* private mode */
    }
    return true;
  } catch (e) {
    setUI({ saveState: "offline" });
    try {
      localStorage.setItem(`mge:backup:${name}`, serializeProject(editor.project));
    } catch {
      /* storage full or blocked */
    }
    if (opts.version) toast(`Save failed: ${(e as Error).message}`, "error");
    return false;
  }
}

export async function openProject(name: string): Promise<boolean> {
  const r = await fetch(`/api/project?name=${encodeURIComponent(name)}`);
  if (!r.ok) return false;
  const p = parseProject(await r.text());
  setUI({ projectName: name, diskName: name, selection: [], keys: [], time: 0, screen: "editor", dialog: null });
  editor.load(p);
  setUI({ saveState: "saved" });
  try {
    localStorage.setItem("mge:last", name);
  } catch {
    /* private mode */
  }
  return true;
}

/** Start a project under a name no other project uses, and save it at once so it shows in the list. */
async function startProject(p: Project, name: string): Promise<boolean> {
  if ((await listProjects()).some((x) => x.name === name)) {
    toast(`A project named "${name}" already exists`, "error");
    return false;
  }
  editor.load(p);
  setUI({ projectName: name, diskName: null, selection: [], keys: [], time: 0, screen: "editor", dialog: null, saveState: "dirty" });
  return saveProject();
}
export const createProject = (name: string) => startProject(makeProject(name), name);

/** The sample lower third, as a new project (lower-third-sample, -2, -3...). */
export async function openSample(): Promise<boolean> {
  const taken = new Set((await listProjects()).map((x) => x.name));
  let name = "lower-third-sample";
  for (let i = 2; taken.has(name); i++) name = `lower-third-sample-${i}`;
  return startProject(lowerThirdProject(), name);
}

/** Back to the project list, saving what is open first. */
export async function goHome(): Promise<void> {
  if (getUI().screen !== "editor") return;
  if (getUI().saveState !== "saved") await saveProject();
  setUI({ screen: "home", dialog: null, playing: false });
}

/** A unique default for the New project field: untitled, untitled-2... */
export function freeName(taken: { name: string }[], stem = "untitled"): string {
  const names = new Set(taken.map((x) => x.name));
  let n = stem;
  for (let i = 2; names.has(n); i++) n = `${stem}-${i}`;
  return n;
}

/**
 * Rename the open project. When this session has it on disk, its folder
 * (with assets and versions) is moved; otherwise the next save just goes to
 * the new name. Names already taken are refused, never overwritten.
 */
export async function renameProject(to: string): Promise<boolean> {
  const from = getUI().projectName;
  if (!to || to === from) return true;
  if ((await listProjects()).some((p) => p.name === to)) {
    toast(`A project named "${to}" already exists`, "error");
    return false;
  }
  // Let a running save finish first, or it would recreate the old folder.
  while (getUI().saveState === "saving") await new Promise((r) => setTimeout(r, 50));
  const { diskName, saveState } = getUI();
  if (diskName === from) {
    setUI({ saveState: "saving" }); // holds the autosave off during the move
    const r = await fetch(`/api/rename?name=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: "POST" }).catch(() => null);
    if (!r?.ok) {
      setUI({ saveState });
      toast(`Rename failed: ${r ? (await r.json()).error : "the project store is offline"}`, "error");
      return false;
    }
    setUI({ projectName: to, diskName: to, saveState });
  } else setUI({ projectName: to, saveState: "dirty" });
  try {
    localStorage.setItem("mge:last", to);
  } catch {
    /* private mode */
  }
  toast(`Renamed to ${to}`);
  return true;
}

export async function listVersions(): Promise<string[]> {
  const r = await fetch(`/api/versions?name=${encodeURIComponent(getUI().projectName)}`);
  return r.ok ? r.json() : [];
}
export async function loadVersion(v: string): Promise<Project> {
  const r = await fetch(`/api/version?name=${encodeURIComponent(getUI().projectName)}&v=${encodeURIComponent(v)}`);
  return parseProject(await r.text());
}

/** Upload into the project's assets/. hasAudio: whether a video has sound (null: unknown). */
export async function uploadAsset(file: File): Promise<{ src: string; hasAudio: boolean | null }> {
  try {
    const r = await fetch(`/api/asset?name=${encodeURIComponent(getUI().projectName)}&file=${encodeURIComponent(file.name)}`, { method: "PUT", body: file });
    if (!r.ok) throw new Error("upload failed");
    const { src, hasAudio } = await r.json();
    return { src, hasAudio: hasAudio ?? null };
  } catch {
    // No local server (static build): embed small files as data URLs.
    if (file.size > 20 * 1024 * 1024) throw new Error("Large media needs the local server (npm run dev)");
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res({ src: String(fr.result), hasAudio: null });
      fr.readAsDataURL(file);
    });
  }
}

export interface ExportRequest {
  format: "prores4444" | "mp4" | "png" | "webm" | "gif" | "fusion";
  fps?: number;
  width?: number;
}
export async function startExport(req: ExportRequest): Promise<{ id: string; out: string }> {
  await saveProject();
  const r = await fetch(`/api/export?name=${encodeURIComponent(getUI().projectName)}`, {
    method: "POST",
    body: JSON.stringify({ ...req, compId: editor.project.activeCompId }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}
export async function exportStatus(id: string) {
  const r = await fetch(`/api/export/status?id=${encodeURIComponent(id)}`);
  return r.json() as Promise<{ status: string; done: number; total: number; out: string; error?: string; notes?: string[] }>;
}
export async function cancelExport(id: string) {
  await fetch(`/api/export/cancel?id=${encodeURIComponent(id)}`, { method: "POST" });
}

// ---------- library: brand kits (ED-15) and templates (ED-16) ----------
export async function listLibrary(kind: "brand" | "template"): Promise<{ name: string; modified: number }[]> {
  const r = await fetch(`/api/library?kind=${kind}`);
  return r.ok ? r.json() : [];
}
export async function loadBrandKit(name: string): Promise<BrandKit> {
  const r = await fetch(`/api/library/item?kind=brand&name=${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error("Brand kit not found");
  return r.json();
}
export async function saveBrandKit(kit: BrandKit): Promise<void> {
  const r = await fetch(`/api/library/item?kind=brand&name=${encodeURIComponent(kit.name)}`, { method: "PUT", body: JSON.stringify(kit, null, 2) });
  if (!r.ok) throw new Error((await r.json()).error);
}
export async function saveAsTemplate(name: string): Promise<void> {
  if (!(await saveProject({ version: true }))) throw new Error("Save failed");
  const r = await fetch(`/api/library/save-template?name=${encodeURIComponent(name)}&from=${encodeURIComponent(getUI().projectName)}`, { method: "POST" });
  if (!r.ok) throw new Error((await r.json()).error);
}
/** Make a new project from a template and open it. */
export async function newFromTemplate(template: string, as: string): Promise<string> {
  const r = await fetch(`/api/library/use-template?name=${encodeURIComponent(template)}&as=${encodeURIComponent(as)}`, { method: "POST" });
  if (!r.ok) throw new Error((await r.json()).error);
  const { name } = await r.json();
  await openProject(name);
  return name;
}
