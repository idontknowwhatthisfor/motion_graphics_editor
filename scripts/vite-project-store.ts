/**
 * Local project store + export jobs, served by the Vite dev server
 * (Milestone 1 runs in a browser window). Everything stays on this Mac and
 * the server only listens on 127.0.0.1.
 *
 * Layout on disk:
 *   projects/<name>/project.json          current project (autosaved)
 *   projects/<name>/versions/<ts>.json    version history (ED-22)
 *   projects/<name>/assets/<file>         imported media (ED-17)
 *   renders/<name>-<comp>.<ext>           exports
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { attachBridge } from "./bridge";

const ROOT = process.cwd();
const PROJECTS = join(ROOT, "projects");
const RENDERS = join(ROOT, "renders");
const VERSION_EVERY_MS = 2 * 60 * 1000;
const MAX_VERSIONS = 60;

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9 _.-]/g, "_").replace(/^\.+/, "").slice(0, 80) || "untitled";
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".json": "application/json",
};

function body(req: IncomingMessage, limit = 2 * 1024 * 1024 * 1024): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) rej(new Error("Body too large"));
      else chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}
function json(res: ServerResponse, code: number, data: unknown) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

interface ExportJob {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  out: string;
  error?: string;
  abort: AbortController;
}
const jobs = new Map<string, ExportJob>();

export function projectStorePlugin(): Plugin {
  return {
    name: "mge-project-store",
    configureServer(server: ViteDevServer) {
      mkdirSync(PROJECTS, { recursive: true });
      const bridge = server.httpServer ? attachBridge(server.httpServer as never, ROOT) : null;
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        // Refuse requests addressed to any other host name (DNS-rebinding guard).
        const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
        if ((path.startsWith("/api/") || path.startsWith("/projects/")) && !["127.0.0.1", "localhost"].includes(hostname))
          return json(res, 403, { error: "local access only" });
        try {
          if (path === "/api/bridge-info" && req.method === "GET") return json(res, 200, { token: bridge?.token ?? null });
          // Static media from project folders.
          if (path.startsWith("/projects/") && req.method === "GET") {
            const file = resolve(ROOT, "." + decodeURIComponent(path));
            if (!file.startsWith(PROJECTS) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: "not found" });
            res.setHeader("content-type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
            return createReadStream(file).pipe(res);
          }
          if (!path.startsWith("/api/")) return next();
          const name = safeName(url.searchParams.get("name") ?? "");
          const dir = join(PROJECTS, name);

          if (path === "/api/projects" && req.method === "GET") {
            const list = readdirSync(PROJECTS, { withFileTypes: true })
              .filter((d) => d.isDirectory() && existsSync(join(PROJECTS, d.name, "project.json")))
              .map((d) => ({ name: d.name, modified: statSync(join(PROJECTS, d.name, "project.json")).mtimeMs }))
              .sort((a, b) => b.modified - a.modified);
            return json(res, 200, list);
          }
          if (path === "/api/project" && req.method === "GET") {
            const f = join(dir, "project.json");
            if (!existsSync(f)) return json(res, 404, { error: "no such project" });
            res.setHeader("content-type", "application/json");
            return res.end(readFileSync(f));
          }
          if (path === "/api/project" && req.method === "PUT") {
            const data = await body(req, 200 * 1024 * 1024);
            JSON.parse(data.toString("utf8")); // refuse invalid JSON
            mkdirSync(join(dir, "versions"), { recursive: true });
            const f = join(dir, "project.json");
            const tmp = f + ".tmp";
            writeFileSync(tmp, data);
            renameSync(tmp, f); // atomic replace: a crash never leaves half a file
            const versions = readdirSync(join(dir, "versions")).filter((v) => v.endsWith(".json")).sort();
            const last = versions[versions.length - 1];
            const lastTime = last ? statSync(join(dir, "versions", last)).mtimeMs : 0;
            if (Date.now() - lastTime > VERSION_EVERY_MS || url.searchParams.get("version") === "1") {
              writeFileSync(join(dir, "versions", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), data);
              for (const old of versions.slice(0, Math.max(0, versions.length + 1 - MAX_VERSIONS))) unlinkSync(join(dir, "versions", old));
            }
            return json(res, 200, { ok: true, savedAt: Date.now() });
          }
          if (path === "/api/versions" && req.method === "GET") {
            const vd = join(dir, "versions");
            const list = existsSync(vd) ? readdirSync(vd).filter((v) => v.endsWith(".json")).sort().reverse() : [];
            return json(res, 200, list);
          }
          if (path === "/api/version" && req.method === "GET") {
            const v = basename(url.searchParams.get("v") ?? "");
            const f = join(dir, "versions", v);
            if (!existsSync(f)) return json(res, 404, { error: "no such version" });
            res.setHeader("content-type", "application/json");
            return res.end(readFileSync(f));
          }
          if (path === "/api/asset" && req.method === "PUT") {
            const file = safeName(url.searchParams.get("file") ?? "asset");
            mkdirSync(join(dir, "assets"), { recursive: true });
            let target = join(dir, "assets", file);
            for (let i = 1; existsSync(target); i++) target = join(dir, "assets", `${i}-${file}`);
            writeFileSync(target, await body(req));
            return json(res, 200, { src: `assets/${basename(target)}` });
          }
          if (path === "/api/export" && req.method === "POST") {
            const opts = JSON.parse((await body(req)).toString("utf8")) as { format: "prores4444" | "mp4" | "png"; fps?: number; width?: number; compId?: string };
            const f = join(dir, "project.json");
            if (!existsSync(f)) return json(res, 400, { error: "Save the project first" });
            const { parseProject } = await server.ssrLoadModule("/src/core/project-io.ts");
            const { exportDirect } = await server.ssrLoadModule("/scripts/lib/node-export.ts");
            const project = parseProject(readFileSync(f, "utf8"));
            const comp = project.compositions.find((c: { id: string }) => c.id === (opts.compId ?? project.activeCompId));
            const ext = opts.format === "mp4" ? ".mp4" : opts.format === "png" ? "" : ".mov";
            mkdirSync(RENDERS, { recursive: true });
            const out = join(RENDERS, `${name}-${safeName(comp?.name ?? "comp")}-${Date.now()}${ext}`);
            const job: ExportJob = { id: `job_${Date.now()}`, status: "running", done: 0, total: 0, out, abort: new AbortController() };
            jobs.set(job.id, job);
            exportDirect(project, dir, opts.compId, {
              format: opts.format,
              out,
              fps: opts.fps,
              width: opts.width,
              signal: job.abort.signal,
              onProgress: (d: number, t: number) => ((job.done = d), (job.total = t)),
            })
              .then(() => (job.status = "done"))
              .catch((e: Error) => {
                job.status = job.abort.signal.aborted ? "cancelled" : "failed";
                job.error = e.message;
              });
            return json(res, 200, { id: job.id, out });
          }
          if (path === "/api/export/status" && req.method === "GET") {
            const job = jobs.get(url.searchParams.get("id") ?? "");
            if (!job) return json(res, 404, { error: "no such job" });
            const { abort: _a, ...rest } = job;
            void _a;
            return json(res, 200, rest);
          }
          if (path === "/api/export/cancel" && req.method === "POST") {
            jobs.get(url.searchParams.get("id") ?? "")?.abort.abort();
            return json(res, 200, { ok: true });
          }
          return json(res, 404, { error: "unknown endpoint" });
        } catch (e) {
          return json(res, 500, { error: (e as Error).message });
        }
      });
    },
  };
}
