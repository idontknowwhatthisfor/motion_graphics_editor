// Bundles src/compiler/runtime-entry.ts into a single IIFE (window.MGE) that
// compiled HyperFrames compositions inline.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [join(root, "src/compiler/runtime-entry.ts")],
  bundle: true,
  format: "iife",
  globalName: "MGE",
  minify: true,
  target: "chrome110",
  outfile: join(root, "src/compiler/runtime.generated.js"),
  legalComments: "none",
});
console.log("runtime bundled -> src/compiler/runtime.generated.js");
