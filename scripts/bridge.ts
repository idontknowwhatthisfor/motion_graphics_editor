/**
 * Local bridge between the open editor (browser) and the MCP server (a stdio
 * process started by Claude Code or the Claude desktop app).
 *
 *   MCP server ──ws "agent"──> bridge (Vite dev server, 127.0.0.1) ──ws "editor"──> browser tab
 *
 * - Listens only on the dev server (bound to 127.0.0.1) at /__mge_bridge.
 * - Every connection must present the per-session token, which is written to
 *   .cache/bridge.json (readable only by this user) on each dev-server start.
 *   The editor fetches it from the same origin; the MCP server reads the file.
 * - The editor connection must also come from the dev server's own origin.
 * - Messages: {id, method, params} -> {id, result} | {id, error}.
 *   The bridge only routes; the editor executes everything through its
 *   Command API, so Claude cannot do anything the UI cannot show and undo.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export const BRIDGE_PATH = "/__mge_bridge";
export const bridgeInfoFile = (root: string) => join(root, ".cache", "bridge.json");

interface Pending {
  agent: WebSocket;
  agentId: string | number;
}

export function attachBridge(httpServer: Server, root: string) {
  const token = randomBytes(24).toString("hex");
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  let editor: WebSocket | null = null;
  const agents = new Set<WebSocket>();
  const pending = new Map<string, Pending>();
  let seq = 0;

  const notifyEditor = (method: string, params: unknown) => editor?.send(JSON.stringify({ method, params }));

  httpServer.on("listening", () => {
    const addr = httpServer.address() as AddressInfo;
    mkdirSync(join(root, ".cache"), { recursive: true });
    const file = bridgeInfoFile(root);
    writeFileSync(file, JSON.stringify({ url: `ws://127.0.0.1:${addr.port}${BRIDGE_PATH}`, http: `http://127.0.0.1:${addr.port}`, token, pid: process.pid }));
    try {
      chmodSync(file, 0o600);
    } catch {
      /* not fatal */
    }
  });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== BRIDGE_PATH) return; // leave Vite's HMR socket alone
    const role = url.searchParams.get("role");
    const ok = url.searchParams.get("token") === token && (role === "editor" || role === "agent");
    const host = req.headers.host ?? "";
    const originOk = role !== "editor" || req.headers.origin === `http://${host}`;
    if (!ok || !originOk) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (role === "editor") {
        editor?.close(4000, "Another editor window took over");
        editor = ws;
        ws.on("message", (raw) => {
          let msg: { id?: string; result?: unknown; error?: unknown };
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          const p = msg.id ? pending.get(msg.id) : undefined;
          if (!p) return;
          pending.delete(msg.id!);
          p.agent.send(JSON.stringify({ id: p.agentId, result: msg.result, error: msg.error }));
        });
        ws.on("close", () => {
          if (editor === ws) editor = null;
          for (const [id, p] of pending) {
            p.agent.send(JSON.stringify({ id: p.agentId, error: "The editor window closed" }));
            pending.delete(id);
          }
        });
        notifyEditor("agents", { count: agents.size });
      } else {
        agents.add(ws);
        notifyEditor("agents", { count: agents.size });
        ws.on("message", (raw) => {
          let msg: { id: string | number; method: string; params?: unknown };
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (!editor) {
            ws.send(JSON.stringify({ id: msg.id, error: "The editor is not open. Run `npm run dev` in the motion_graphics folder and open http://127.0.0.1:5173." }));
            return;
          }
          const id = `r${++seq}`;
          pending.set(id, { agent: ws, agentId: msg.id });
          editor.send(JSON.stringify({ id, method: msg.method, params: msg.params }));
        });
        ws.on("close", () => {
          agents.delete(ws);
          notifyEditor("agents", { count: agents.size });
        });
      }
    });
  });

  return { token };
}
