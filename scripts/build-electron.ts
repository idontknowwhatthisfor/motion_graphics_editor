/** Bundle the Mac app's main process and preload into dist-electron/ (ED-26). */
import { build } from "esbuild";
import { join } from "node:path";
import { ROOT } from "./lib/node-export";

const common = { bundle: true, platform: "node" as const, target: "node22", sourcemap: true, logLevel: "warning" as const };
await build({
  ...common,
  entryPoints: [join(ROOT, "electron/main.ts")],
  outfile: join(ROOT, "dist-electron/main.mjs"),
  format: "esm",
  packages: "external", // node_modules load from the repo at runtime
});
await build({
  ...common,
  entryPoints: [join(ROOT, "electron/preload.ts")],
  outfile: join(ROOT, "dist-electron/preload.cjs"),
  format: "cjs", // sandboxed preloads must be CommonJS
  external: ["electron"],
});
console.log("Built dist-electron/main.mjs and preload.cjs");
