// Entry point for Electron (package.json "main"). Plain JS so it runs before
// anything is bundled: it fixes the working folder, then loads the app.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.MGE_ROOT ??= resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(process.env.MGE_ROOT);
// Apps opened from the Dock get a bare PATH; add Homebrew's so ffmpeg, ffprobe and npx are found.
if (process.platform === "darwin")
  process.env.PATH = [...new Set(["/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "/usr/bin:/bin").split(":")])].join(":");
await import(pathToFileURL(resolve(process.env.MGE_ROOT, "dist-electron/main.mjs")).href);
