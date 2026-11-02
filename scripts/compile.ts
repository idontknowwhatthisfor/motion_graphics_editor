/** Compile a project to a HyperFrames folder: npm run compile -- <project.json> [outDir] */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseProject } from "../src/core/project-io";
import { ROOT, writeHyperFramesProject } from "./lib/node-export";

const [file, out] = process.argv.slice(2);
if (!file) throw new Error("usage: npm run compile -- <project.json> [outDir]");
const p = parseProject(readFileSync(file, "utf8"));
const dir = resolve(out ?? join(ROOT, "renders", "hyperframes", p.name.replace(/\W+/g, "-")));
const c = writeHyperFramesProject(p, dirname(resolve(file)), dir);
console.log(`Compiled "${p.name}" (${c.width}x${c.height}, ${c.duration}s @ ${c.fps}fps) -> ${dir}`);
