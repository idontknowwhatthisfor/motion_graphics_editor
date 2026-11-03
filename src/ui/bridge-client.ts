/**
 * Editor side of the Claude bridge (see scripts/bridge.ts). Executes MCP
 * requests against the same Editor and Command API the UI uses, always with
 * source "claude" so edits land in a reviewable change set.
 */
import type { Command } from "../core/commands";
import { NO_PROJECT_OPEN, serializeProject } from "../core/project-io";
import { saveProject, startExport } from "./api";
import { editor, getUI, setUI } from "./state";

type Handler = (params: any) => unknown | Promise<unknown>;

let pendingExport: ((approved: boolean) => void) | null = null;
/** Called by the approval card. */
export function answerExportRequest(approved: boolean) {
  pendingExport?.(approved);
  pendingExport = null;
  setUI({ exportRequest: null });
}

function setClaude(patch: Partial<ReturnType<typeof getUI>["claude"]>) {
  setUI((s) => ({ claude: { ...s.claude, ...patch } }));
}

/** Stop button: finish Claude's current change set and refuse edits until resumed. */
export function stopClaude() {
  const open = editor.openChangeSet;
  if (open) editor.finishChangeSet(open.id);
  setClaude({ stopped: true, action: null });
}
export function resumeClaude() {
  setClaude({ stopped: false });
}

function changeSetSummary() {
  return editor.changeSets.map((c) => ({ id: c.id, name: c.name, status: c.status, edits: c.entries.length, layerIds: c.layerIds }));
}

/** On the Projects screen the editor holds only the unsaved sample, so Claude's edits would be lost. */
function needOpenProject() {
  if (getUI().screen !== "editor") throw new Error(NO_PROJECT_OPEN);
}

const handlers: Record<string, Handler> = {
  getState: () => {
    const ui = getUI();
    return {
      projectOpen: ui.screen === "editor",
      projectName: ui.projectName,
      project: JSON.parse(serializeProject(editor.project)),
      selection: ui.selection,
      time: ui.time,
      activeCompId: editor.project.activeCompId,
      permissionMode: editor.project.settings.permissionMode,
      stopped: ui.claude.stopped,
      changeSets: changeSetSummary(),
    };
  },
  activity: (p: { action: string | null }) => {
    setClaude({ action: p.action });
    return true;
  },
  dispatch: (p: { commands: Command[]; label?: string }) => {
    needOpenProject();
    if (getUI().claude.stopped) throw new Error("Stopped by the user. Ask them to press Resume in the Claude panel.");
    const r = editor.dispatch(p.commands, { source: "claude", label: p.label });
    if (!r.ok) throw new Error(r.error ?? "Command failed");
    return { results: r.results, changeSetId: r.changeSetId };
  },
  beginChangeSet: (p: { name: string }) => {
    needOpenProject();
    if (getUI().claude.stopped) throw new Error("Stopped by the user.");
    if (editor.project.settings.permissionMode === "readOnly") throw new Error("Project is in Read only mode for Claude");
    return { changeSetId: editor.beginChangeSet(p.name).id };
  },
  finishChangeSet: () => {
    const open = editor.openChangeSet;
    if (!open) return { status: "none", message: "No open change set" };
    const cs = editor.finishChangeSet(open.id);
    return { changeSetId: open.id, status: cs?.status ?? "empty" };
  },
  getChangeSets: () => changeSetSummary(),
  requestExport: async (p: { format: string; fps?: number; width?: number }) => {
    needOpenProject();
    if (pendingExport) throw new Error("Another export request is waiting for approval");
    setUI({ exportRequest: p });
    const approved = await new Promise<boolean>((res) => (pendingExport = res));
    if (!approved) throw new Error("The user declined the export");
    await saveProject();
    return startExport({ format: p.format as "prores4444" | "mp4" | "png" | "webm" | "gif", fps: p.fps, width: p.width });
  },
};

export function startBridge() {
  let retry = 1000;
  const connect = async () => {
    let token: string | null = null;
    try {
      token = (await (await fetch("/api/bridge-info")).json()).token;
    } catch {
      /* static build: no bridge */
    }
    if (!token) {
      setClaude({ bridge: "down" });
      return;
    }
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/__mge_bridge?role=editor&token=${token}`);
    ws.onopen = () => {
      retry = 1000;
      setClaude({ bridge: "up" });
    };
    ws.onclose = (e) => {
      setClaude({ bridge: "down", agents: 0, action: null });
      if (e.code === 4000) return; // another window took over
      setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
    };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: string; method: string; params?: unknown };
      if (!msg.id) {
        if (msg.method === "agents") setClaude({ agents: (msg.params as { count: number }).count });
        return;
      }
      try {
        const h = handlers[msg.method];
        if (!h) throw new Error(`Unknown method ${msg.method}`);
        const result = await h(msg.params ?? {});
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, error: (e as Error).message }));
      }
    };
  };
  connect();
}
