import { PROJECT_FORMAT, PROJECT_FORMAT_VERSION, type Project } from "./types";

export class ProjectFormatError extends Error {}

/**
 * Parse and lightly validate a project file. Older versions are migrated
 * here (none yet); newer versions are refused rather than silently damaged.
 */
export function parseProject(json: string | unknown): Project {
  const raw = typeof json === "string" ? JSON.parse(json) : json;
  if (!raw || typeof raw !== "object") throw new ProjectFormatError("Project file is not an object");
  const p = raw as Partial<Project>;
  if (p.format !== PROJECT_FORMAT) throw new ProjectFormatError(`Not a project file (format=${String(p.format)})`);
  if (typeof p.version !== "number") throw new ProjectFormatError("Missing version");
  if (p.version > PROJECT_FORMAT_VERSION)
    throw new ProjectFormatError(`Project version ${p.version} is newer than this editor (${PROJECT_FORMAT_VERSION})`);
  if (!Array.isArray(p.compositions) || p.compositions.length === 0) throw new ProjectFormatError("No compositions");
  for (const c of p.compositions) {
    if (!Array.isArray(c.layers)) throw new ProjectFormatError(`Composition ${c.id} has no layers array`);
    c.markers ??= [];
    for (const l of c.layers) {
      l.masks ??= [];
      l.matte ??= null;
      l.parentId ??= null;
      l.effects ??= [];
    }
  }
  p.assets ??= [];
  p.settings ??= { permissionMode: "ask" };
  if (!p.compositions.some((c) => c.id === p.activeCompId)) p.activeCompId = p.compositions[0].id;
  return p as Project;
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2);
}

/** What Claude is told while the editor shows the Projects screen (no project open). */
export const NO_PROJECT_OPEN =
  "No project is open: the editor is showing the Projects screen. Ask the user to open a project or create one there, then try again.";
