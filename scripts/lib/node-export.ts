/**
 * Node-side compile, frame rendering and export.
 *
 * Two render paths share the compiled HyperFrames HTML:
 *  1. HyperFrames CLI (`npx hyperframes render --format mov`): the engine
 *     the PRD chose; used once the engine test passes on the Mac.
 *  2. Direct: Playwright screenshots with a transparent background piped
 *     into FFmpeg. Small, dependable fallback, also used for frame checks.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import { compileToHyperFrames, exportedAssetPath, type CompiledComposition } from "../../src/compiler/hyperframes";
import type { Project } from "../../src/core/types";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

export function runtimeJs(): string {
  const p = join(ROOT, "src/compiler/runtime.generated.js");
  if (!existsSync(p)) throw new Error("Runtime not built. Run: npm run build:runtime");
  return readFileSync(p, "utf8");
}

/** Write a self-contained HyperFrames project folder. */
export function writeHyperFramesProject(project: Project, projectDir: string, outDir: string, compId?: string): CompiledComposition {
  mkdirSync(join(outDir, "assets"), { recursive: true });
  const compiled = compileToHyperFrames(project, { compId, runtimeJs: runtimeJs(), gsapSrc: "assets/gsap.min.js" });
  writeFileSync(join(outDir, "index.html"), compiled.html);
  copyFileSync(require.resolve("gsap/dist/gsap.min.js"), join(outDir, "assets/gsap.min.js"));
  for (const a of compiled.assets) {
    if (a.src.startsWith("data:")) continue;
    const src = isAbsolute(a.src) ? a.src : join(projectDir, a.src);
    const dest = join(outDir, exportedAssetPath(a));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  return compiled;
}

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  // Prefer an explicit path, then a browser already on the machine, so the
  // ~150 MB `npx playwright install chromium` download is optional.
  const candidates = [
    process.env.MGE_CHROMIUM,
    "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ];
  const executablePath = candidates.find((p) => p && existsSync(p));
  return chromium.launch({ executablePath, args: ["--disable-gpu-vsync", "--font-render-hinting=none"] });
}

export async function openComposition(browser: Browser, htmlDir: string, width: number, height: number, scale = 1): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(htmlDir, "index.html")).href, { waitUntil: "load" });
  await page.evaluate(() => (document as Document).fonts.ready);
  return page;
}

export async function seekAndShoot(page: Page, t: number): Promise<Buffer> {
  await page.evaluate((tt) => {
    (window as unknown as { __mgeSeek: (t: number) => void }).__mgeSeek(tt);
    return new Promise((r) => requestAnimationFrame(() => r(null)));
  }, t);
  return page.locator("#root").screenshot({ omitBackground: true, type: "png" });
}

export type ExportFormat = "prores4444" | "mp4" | "png";
export interface ExportOptions {
  format: ExportFormat;
  out: string;
  fps?: number;
  /** Output width; height follows the composition's aspect ratio. */
  width?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export function ffmpegArgs(format: ExportFormat, fps: number, out: string): string[] {
  const input = ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-"];
  if (format === "prores4444")
    // ProRes 4444 with straight alpha; "apl0" vendor tag helps Resolve/FCP.
    return [...input, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-vendor", "apl0", "-r", String(fps), out];
  if (format === "mp4")
    return [...input, "-filter_complex", "color=black,format=rgb24[bg];[bg][0:v]scale2ref[bg2][fg];[bg2][fg]overlay=shortest=1:format=auto,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", "-r", String(fps), out];
  throw new Error(`No ffmpeg args for ${format}`);
}

/** Direct export: compile, screenshot every frame, encode. */
export async function exportDirect(project: Project, projectDir: string, compId: string | undefined, opts: ExportOptions) {
  const comp = project.compositions.find((c) => c.id === (compId ?? project.activeCompId)) ?? project.compositions[0];
  const fps = opts.fps ?? comp.fps;
  const scale = opts.width ? opts.width / comp.width : 1;
  const work = join(ROOT, ".cache", `export-${Date.now()}`);
  writeHyperFramesProject(project, projectDir, work, comp.id);
  const total = Math.round(comp.duration * fps);
  const browser = await launchBrowser();
  try {
    const page = await openComposition(browser, work, comp.width, comp.height, scale);
    if (opts.format === "png") {
      mkdirSync(opts.out, { recursive: true });
      for (let i = 0; i < total; i++) {
        if (opts.signal?.aborted) throw new Error("Export cancelled");
        writeFileSync(join(opts.out, `frame_${String(i).padStart(5, "0")}.png`), await seekAndShoot(page, i / fps));
        opts.onProgress?.(i + 1, total);
      }
      return { out: opts.out, frames: total };
    }
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    const ff = spawn("ffmpeg", ffmpegArgs(opts.format, fps, opts.out), { stdio: ["pipe", "inherit", "pipe"] });
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    const done = new Promise<void>((res, rej) => ff.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg failed (${code}): ${err}`)))));
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) {
        ff.kill("SIGKILL");
        throw new Error("Export cancelled");
      }
      const png = await seekAndShoot(page, i / fps);
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      opts.onProgress?.(i + 1, total);
    }
    ff.stdin.end();
    await done;
    return { out: opts.out, frames: total };
  } finally {
    await browser.close();
  }
}

/** ffprobe summary used by tests, the engine test and export checks. */
export async function probe(file: string): Promise<{ codec: string; profile?: string; pixFmt: string; width: number; height: number; frames: number; fps: string; hasAlpha: boolean }> {
  const out = await new Promise<string>((res, rej) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,nb_read_frames,r_frame_rate", "-of", "json", file]);
    let s = "";
    p.stdout.on("data", (d) => (s += d));
    p.on("close", (c) => (c === 0 ? res(s) : rej(new Error("ffprobe failed"))));
  });
  const st = JSON.parse(out).streams[0];
  return {
    codec: st.codec_name,
    profile: st.profile,
    pixFmt: st.pix_fmt,
    width: st.width,
    height: st.height,
    frames: Number(st.nb_read_frames),
    fps: st.r_frame_rate,
    hasAlpha: /yuva|rgba|argb|bgra|gbrap/.test(st.pix_fmt),
  };
}
