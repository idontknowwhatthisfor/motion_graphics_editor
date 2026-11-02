/**
 * Export a project file.
 *   npm run export -- <project.json> [--format prores4444|mp4|png] [--out file]
 *                     [--fps 30] [--width 1920] [--comp <id>] [--resolve]
 *                     [--engine direct|hyperframes]
 * --resolve: the Resolve-ready preset (ProRes 4444, straight alpha, .mov).
 * --engine hyperframes: compile and render with the pinned HyperFrames CLI
 *   (mov = ProRes 4444 with alpha) instead of the built-in direct exporter.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseProject } from "../src/core/project-io";
import { spawnSync } from "node:child_process";
import { exportDirect, probe, ROOT, writeHyperFramesProject, type ExportFormat } from "./lib/node-export";

export const HYPERFRAMES_VERSION = "0.9.4";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: npm run export -- <project.json> [--format prores4444|mp4|png] [--out path] [--fps n] [--width n] [--resolve]");
  process.exit(1);
}
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const project = parseProject(readFileSync(file, "utf8"));
const format = (args.includes("--resolve") ? "prores4444" : opt("format") ?? "prores4444") as ExportFormat;
const ext = format === "mp4" ? ".mp4" : format === "png" ? "" : ".mov";
const out = resolve(opt("out") ?? join(ROOT, "renders", basename(file).replace(/\.json$/, "") + ext));
if (opt("engine") === "hyperframes") {
  const dir = join(ROOT, ".cache", "hf-export");
  writeHyperFramesProject(project, dirname(resolve(file)), dir, opt("comp"));
  const hfFormat = format === "mp4" ? "mp4" : format === "png" ? "png-sequence" : "mov";
  const args = ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "render", "--format", hfFormat, "--quality", "delivery", "-o", out];
  if (opt("fps")) args.push("--fps", opt("fps")!);
  const r = spawnSync("npx", args, { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (format !== "png") console.log(await probe(out));
  process.exit(0);
}
let last = 0;
const r = await exportDirect(project, dirname(resolve(file)), opt("comp"), {
  format,
  out,
  fps: opt("fps") ? Number(opt("fps")) : undefined,
  width: opt("width") ? Number(opt("width")) : undefined,
  onProgress: (d, t) => {
    const pct = Math.floor((d / t) * 100);
    if (pct >= last + 10) (last = pct), console.log(`${pct}% (${d}/${t})`);
  },
});
console.log(`Wrote ${r.out}`);
if (format !== "png") console.log(await probe(r.out));
