/**
 * How the MCP server reaches the open project. The tools only talk to an
 * EditorPort, so they are tested in-process (LocalPort) and run for real
 * over the local bridge (BridgePort).
 */
import { existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";
import type { Command } from "../src/core/commands";
import { Editor } from "../src/core/editor";
import { NO_PROJECT_OPEN } from "../src/core/project-io";
import type { Project } from "../src/core/types";

export interface EditorState {
  /** False while the editor shows the Projects screen (older editors omit it: open). */
  projectOpen?: boolean;
  projectName: string;
  project: Project;
  selection: string[];
  time: number;
  activeCompId: string;
  permissionMode: string;
  stopped: boolean;
  changeSets: { id: string; name: string; status: string; edits: number; layerIds: string[] }[];
}

export interface EditorPort {
  state(): Promise<EditorState>;
  dispatch(commands: Command[], label?: string): Promise<{ results: unknown[]; changeSetId?: string }>;
  beginChangeSet(name: string): Promise<{ changeSetId: string }>;
  finishChangeSet(): Promise<{ changeSetId?: string; status: string }>;
  activity(action: string | null): Promise<void>;
  requestExport(p: { format: string; fps?: number; width?: number }): Promise<{ id: string; out: string }>;
  exportStatus(id: string): Promise<ExportStatus>;
  cancelExport(id: string): Promise<void>;
}

export interface ExportStatus {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  out?: string;
  error?: string;
  /** Fusion export: layers flattened to PNG frames, values baked, things left out. */
  notes?: string[];
}

/** In-process port for tests and scripts. */
export class LocalPort implements EditorPort {
  /** Set false to act like the editor on its Projects screen. */
  projectOpen = true;
  selection: string[] = [];
  time = 0;
  exportApproved = false;
  constructor(public editor: Editor, public projectName = "test") {}
  async state(): Promise<EditorState> {
    return {
      projectOpen: this.projectOpen,
      projectName: this.projectName,
      project: this.editor.project,
      selection: this.selection,
      time: this.time,
      activeCompId: this.editor.project.activeCompId,
      permissionMode: this.editor.project.settings.permissionMode,
      stopped: false,
      changeSets: this.editor.changeSets.map((c) => ({ id: c.id, name: c.name, status: c.status, edits: c.entries.length, layerIds: c.layerIds })),
    };
  }
  async dispatch(commands: Command[], label?: string) {
    if (!this.projectOpen) throw new Error(NO_PROJECT_OPEN);
    const r = this.editor.dispatch(commands, { source: "claude", label });
    if (!r.ok) throw new Error(r.error);
    return { results: r.results, changeSetId: r.changeSetId };
  }
  async beginChangeSet(name: string) {
    if (!this.projectOpen) throw new Error(NO_PROJECT_OPEN);
    return { changeSetId: this.editor.beginChangeSet(name).id };
  }
  async finishChangeSet() {
    const open = this.editor.openChangeSet;
    if (!open) return { status: "none" };
    return { changeSetId: open.id, status: this.editor.finishChangeSet(open.id)?.status ?? "empty" };
  }
  async activity() {}
  async requestExport() {
    if (!this.projectOpen) throw new Error(NO_PROJECT_OPEN);
    if (!this.exportApproved) throw new Error("The user declined the export");
    return { id: "job_test", out: "/tmp/test.mov" };
  }
  /** Fake job for tests: advances 25% per status call unless cancelled. */
  fakeJob: ExportStatus = { id: "job_test", status: "running", done: 0, total: 4, out: "/tmp/test.mov" };
  async exportStatus(id: string): Promise<ExportStatus> {
    if (id !== this.fakeJob.id) throw new Error("no such job");
    const j = this.fakeJob;
    if (j.status === "running" && ++j.done >= j.total) j.status = "done";
    return { ...j };
  }
  async cancelExport() {
    if (this.fakeJob.status === "running") this.fakeJob.status = "cancelled";
  }
}

/** Real port: WebSocket to the bridge in the running dev server. */
export class BridgePort implements EditorPort {
  private ws: WebSocket | null = null;
  private seq = 0;
  private waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private info: { url: string; http: string; token: string } | null = null;
  constructor(private infoFile: string) {}

  private readInfo() {
    if (!existsSync(this.infoFile)) return null;
    try {
      return JSON.parse(readFileSync(this.infoFile, "utf8"));
    } catch {
      return null;
    }
  }

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    const info = this.readInfo();
    if (!info) return Promise.reject(new Error("The editor is not running. In the motion_graphics folder run `npm run dev`, then open http://127.0.0.1:5173."));
    this.info = info;
    return new Promise((res, rej) => {
      const ws = new WebSocket(`${info.url}?role=agent&token=${info.token}`);
      ws.on("open", () => {
        this.ws = ws;
        res(ws);
      });
      ws.on("error", () => rej(new Error("Could not reach the editor. Is `npm run dev` running?")));
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { id: number; result?: unknown; error?: string };
        const w = this.waiting.get(msg.id);
        if (!w) return;
        this.waiting.delete(msg.id);
        if (msg.error) w.rej(new Error(msg.error));
        else w.res(msg.result);
      });
      ws.on("close", () => {
        this.ws = null;
        for (const [, w] of this.waiting) w.rej(new Error("Connection to the editor closed"));
        this.waiting.clear();
      });
    });
  }

  async call<T>(method: string, params: unknown = {}, timeoutMs = 30000): Promise<T> {
    const ws = await this.connect();
    const id = ++this.seq;
    return new Promise<T>((res, rej) => {
      const timer = timeoutMs > 0 ? setTimeout(() => (this.waiting.delete(id), rej(new Error(`Editor did not answer ${method} in time`))), timeoutMs) : null;
      this.waiting.set(id, {
        res: (v) => (timer && clearTimeout(timer), res(v as T)),
        rej: (e) => (timer && clearTimeout(timer), rej(e)),
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  state() {
    return this.call<EditorState>("getState");
  }
  dispatch(commands: Command[], label?: string) {
    return this.call<{ results: unknown[]; changeSetId?: string }>("dispatch", { commands, label });
  }
  beginChangeSet(name: string) {
    return this.call<{ changeSetId: string }>("beginChangeSet", { name });
  }
  finishChangeSet() {
    return this.call<{ changeSetId?: string; status: string }>("finishChangeSet");
  }
  async activity(action: string | null) {
    await this.call("activity", { action }).catch(() => undefined);
  }
  requestExport(p: { format: string; fps?: number; width?: number }) {
    // Waits for the user to approve in the editor (up to 10 minutes).
    return this.call<{ id: string; out: string }>("requestExport", p, 10 * 60 * 1000);
  }
  private httpBase() {
    const base = (this.info ?? this.readInfo())?.http;
    if (!base) throw new Error("The editor is not running");
    return base as string;
  }
  async exportStatus(id: string): Promise<ExportStatus> {
    const r = await fetch(`${this.httpBase()}/api/export/status?id=${encodeURIComponent(id)}`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? `export status failed (${r.status})`);
    return body;
  }
  async cancelExport(id: string) {
    await fetch(`${this.httpBase()}/api/export/cancel?id=${encodeURIComponent(id)}`, { method: "POST" });
  }
  close() {
    this.ws?.close();
  }
}
