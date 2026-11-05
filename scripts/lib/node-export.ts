/**
 * Node-side compile, frame rendering and export.
 *
 * Two render paths share the compiled HyperFrames HTML:
 *  1. HyperFrames CLI (`npx hyperframes render --format mov`): the engine
 *     the PRD chose; used once the engine test passes on the Mac.
 *  2. Direct: Playwright screenshots with a transparent background piped
 *     into FFmpeg. Small, dependable fallback, also used for frame checks.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import { compileToFusion } from "../../src/compiler/fusion";
import { compileToHyperFrames, exportedAssetPath, type CompiledComposition } from "../../src/compiler/hyperframes";
import { valueAt } from "../../src/core/interpolate";
import type { AudioLayer, Project } from "../../src/core/types";

export const ROOT = process.env.MGE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

export function runtimeJs(): string {
  const p = join(ROOT, "src/compiler/runtime.generated.js");
  if (!existsSync(p)) throw new Error("Runtime not built. Run: npm run build:runtime");
  return readFileSync(p, "utf8");
}

/**
 * Turn a video asset into numbered PNG stills at `fps` (ED-23), cached in
 * .cache/stills/ until the source file changes. Chrome cannot seek every
 * codec (ProRes, HEVC with alpha) frame-accurately; FFmpeg can.
 */
export function extractStills(src: string, assetId: string, fps: number): { pattern: string; fps: number; count: number } {
  const st = statSync(src);
  const dir = join(ROOT, ".cache", "stills", `${assetId}_${fps}_${Math.round(st.mtimeMs)}_${st.size}`);
  const done = join(dir, "done.json");
  if (!existsSync(done)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-vf", `fps=${fps}`, "-pix_fmt", "rgba", join(dir, "%05d.png")], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Could not read video ${src}: ${r.stderr || r.error?.message}`);
    writeFileSync(done, JSON.stringify({ count: readdirSync(dir).filter((f) => f.endsWith(".png")).length }));
  }
  const { count } = JSON.parse(readFileSync(done, "utf8")) as { count: number };
  return { pattern: pathToFileURL(dir).href + "/%05d.png", fps, count };
}

/**
 * Write a self-contained HyperFrames project folder. With `stills`, video
 * layers are drawn from FFmpeg-extracted frames (direct exporter and frame
 * checks); without it they stay <video> elements (HyperFrames CLI).
 */
export function writeHyperFramesProject(project: Project, projectDir: string, outDir: string, compId?: string, stills?: { fps: number }): CompiledComposition {
  mkdirSync(join(outDir, "assets"), { recursive: true });
  const videoFrames: Record<string, { pattern: string; fps: number; count: number }> = {};
  if (stills) {
    const videoAssetIds = new Set(project.compositions.flatMap((c) => c.layers.filter((l) => l.type === "video").map((l) => (l as { assetId: string }).assetId)));
    for (const a of project.assets)
      if (videoAssetIds.has(a.id) && !a.src.startsWith("data:")) videoFrames[a.id] = extractStills(isAbsolute(a.src) ? a.src : join(projectDir, a.src), a.id, stills.fps);
  }
  const compiled = compileToHyperFrames(project, { compId, runtimeJs: runtimeJs(), gsapSrc: "assets/gsap.min.js", videoFrames });
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

export const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * The browser used for export, frame checks, tests AND HyperFrames: Google
 * Chrome, never a downloaded Chromium. Override with MGE_CHROME (any Chrome
 * binary). /opt/pw-browsers/chromium is only used in the cloud build
 * container, which has no Chrome.
 */
export function chromePath(): string {
  const p = process.env.MGE_CHROME || process.env.MGE_CHROMIUM;
  if (p) {
    if (!existsSync(p)) throw new Error(`MGE_CHROME points to a missing file: ${p}`);
    return p;
  }
  if (process.platform === "darwin") {
    if (existsSync(MAC_CHROME)) return MAC_CHROME;
    const user = join(process.env.HOME ?? "", MAC_CHROME);
    if (existsSync(user)) return user;
    throw new Error("Google Chrome was not found in /Applications. Install it from google.com/chrome, or set MGE_CHROME to its binary.");
  }
  for (const c of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/opt/pw-browsers/chromium"]) if (existsSync(c)) return c;
  throw new Error("Google Chrome was not found. Set MGE_CHROME to its binary.");
}

/** Environment that makes the HyperFrames CLI use the same Chrome. */
export function hyperframesEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HYPERFRAMES_BROWSER_PATH: chromePath() };
}

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({ executablePath: chromePath(), args: ["--disable-gpu-vsync", "--font-render-hinting=none"] });
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
    // Video stills and images must be decoded before the screenshot.
    const imgs = Array.from(document.querySelectorAll("image")).map((el) => {
      const i = new Image();
      i.src = el.getAttribute("href") ?? "";
      return i.decode().catch(() => undefined);
    });
    return Promise.all(imgs).then(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }, t);
  return page.locator("#root").screenshot({ omitBackground: true, type: "png" });
}

export type ExportFormat = "prores4444" | "mp4" | "png" | "webm" | "gif" | "fusion";
export const EXPORT_FORMATS: ExportFormat[] = ["prores4444", "mp4", "png", "webm", "gif", "fusion"];
/** File extension per format; png is a folder of frames, fusion a folder with the .comp, .setting and media. */
export const EXPORT_EXT: Record<ExportFormat, string> = { prores4444: ".mov", mp4: ".mp4", png: "", webm: ".webm", gif: ".gif", fusion: "-fusion" };
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
  if (format === "webm")
    // VP9 with alpha (yuva420p); alt-ref frames must be off for alpha.
    return [...input, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "28", "-auto-alt-ref", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-r", String(fps), out];
  if (format === "gif")
    // One pass: palettegen buffers the frames, paletteuse keeps 1-bit transparency.
    return [...input, "-filter_complex", "[0:v]split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:alpha_threshold=128", "-loop", "0", "-r", String(fps), out];
  throw new Error(`No ffmpeg args for ${format}`);
}

/** Direct export: compile, screenshot every frame, encode. */
export async function exportDirect(project: Project, projectDir: string, compId: string | undefined, opts: ExportOptions): Promise<{ out: string; frames: number; notes?: string[] }> {
  if (opts.format === "fusion") return exportFusion(project, projectDir, compId, opts);
  const comp = project.compositions.find((c) => c.id === (compId ?? project.activeCompId)) ?? project.compositions[0];
  const fps = opts.fps ?? comp.fps;
  const scale = opts.width ? opts.width / comp.width : 1;
  const work = join(ROOT, ".cache", `export-${Date.now()}`);
  writeHyperFramesProject(project, projectDir, work, comp.id, { fps });
  const total = Math.round(comp.duration * fps);
  const audio = opts.format === "png" || opts.format === "gif" ? [] : audioInputs(project, comp.id, projectDir);
  const videoOut = audio.length ? opts.out.replace(/(\.[a-z0-9]+)$/i, ".video$1") : opts.out;
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
    const ff = spawn("ffmpeg", ffmpegArgs(opts.format, fps, videoOut), { stdio: ["pipe", "inherit", "pipe"] });
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.stdin.on("error", () => undefined); // EPIPE if ffmpeg dies; reported through `done`
    const done = new Promise<void>((res, rej) => ff.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg failed (${code}): ${err}`)))));
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) {
        done.catch(() => undefined); // the kill below makes it reject; nobody awaits it now
        ff.kill("SIGKILL");
        await new Promise((r) => ff.once("close", r)).catch(() => undefined);
        rmSync(videoOut, { force: true });
        throw new Error("Export cancelled");
      }
      const png = await seekAndShoot(page, i / fps);
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      opts.onProgress?.(i + 1, total);
    }
    ff.stdin.end();
    await done;
    if (audio.length) {
      muxAudio(videoOut, audio, comp.duration, opts.format, opts.out);
      rmSync(videoOut, { force: true });
    }
    return { out: opts.out, frames: total };
  } finally {
    await browser.close();
  }
}

/**
 * Fusion export: a folder with <comp>.comp (Fusion page: File › Import ›
 * Fusion Composition), <comp>.setting (paste into a node view), the images
 * it loads, and PNG sequences of the layers Fusion nodes can't express
 * (rendered by our renderer with every other layer hidden).
 */
export async function exportFusion(project: Project, projectDir: string, compId: string | undefined, opts: ExportOptions) {
  const comp = project.compositions.find((c) => c.id === (compId ?? project.activeCompId)) ?? project.compositions[0];
  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  const r = compileToFusion(project, { compId: comp.id, fps: opts.fps, width: opts.width, outDir: out });
  for (const { asset, path } of r.assets) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    copyFileSync(isAbsolute(asset.src) ? asset.src : join(projectDir, asset.src), join(out, path));
  }
  const total = Math.max(1, r.groups.reduce((n, g) => n + g.frames, 0));
  let done = 0;
  for (const g of r.groups) {
    // Same project, only this group's layers drawn (matte sources keep their state; parents still move them).
    const only = new Set(g.layerIds);
    const mattes = new Set(comp.layers.filter((l) => only.has(l.id) && l.matte).map((l) => l.matte!.layerId));
    const solo: Project = {
      ...project,
      compositions: project.compositions.map((c) =>
        c.id !== comp.id ? c : { ...c, background: null, layers: c.layers.map((l) => (only.has(l.id) || mattes.has(l.id) ? l : { ...l, visible: false })) },
      ),
    };
    const before = done;
    await exportDirect(solo, projectDir, comp.id, {
      format: "png",
      out: join(out, g.dir),
      fps: r.fps,
      width: r.width,
      signal: opts.signal,
      onProgress: (d) => opts.onProgress?.(before + d, total),
    });
    done += g.frames;
  }
  writeFileSync(join(out, `${r.fileName}.comp`), r.comp);
  writeFileSync(join(out, `${r.fileName}.setting`), r.setting);
  writeFileSync(
    join(out, "README.txt"),
    [
      `${project.name} / ${comp.name}: ${r.width}x${r.height}, ${r.fps} fps, ${r.frames} frames.`,
      "",
      "In DaVinci Resolve:",
      `  - Whole comp: put a Fusion Composition on the timeline (Effects Library › Toolbox › Effects › Fusion Composition), open it on the Fusion page, then File › Import › Fusion Composition and pick ${r.fileName}.comp.`,
      `  - Or open ${r.fileName}.setting in a text editor, copy everything and paste it into any Fusion node view, then connect the top Merge to MediaOut.`,
      "  Keep this folder where it is: the Loaders point at the images and PNG frames inside it.",
      "",
      ...(r.notes.length ? ["Notes:", ...r.notes.map((n) => `  - ${n}`)] : []),
      "",
    ].join("\n"),
  );
  opts.onProgress?.(total, total);
  return { out, frames: r.frames, notes: r.notes };
}

type AudioInput = { file: string; start: number; offset: number; duration: number; volume: number };

/** Audio layers of a comp (top level), as FFmpeg inputs (ED-14). */
export function audioInputs(project: Project, compId: string, projectDir: string): AudioInput[] {
  const comp = project.compositions.find((c) => c.id === compId);
  if (!comp) return [];
  const out: AudioInput[] = [];
  for (const l of comp.layers) {
    if (l.type !== "audio" || !l.visible) continue;
    const a = project.assets.find((x) => x.id === (l as AudioLayer).assetId);
    if (!a || a.src.startsWith("data:")) continue;
    const start = Math.max(0, l.inPoint);
    const end = Math.min(comp.duration, l.outPoint);
    if (end <= start) continue;
    out.push({ file: isAbsolute(a.src) ? a.src : join(projectDir, a.src), start, offset: Math.max(0, l.mediaOffset + (start - l.inPoint)), duration: end - start, volume: Math.max(0, valueAt((l as AudioLayer).volume, start)) / 100 });
  }
  return out;
}

/** FFmpeg arguments that lay the audio layers over the rendered video. */
export function muxArgs(video: string, audio: AudioInput[], duration: number, format: ExportFormat, out: string): string[] {
  const chains = audio.map((a, i) => {
    const ms = Math.round(a.start * 1000);
    return `[${i + 1}:a]atrim=start=${a.offset.toFixed(4)}:duration=${a.duration.toFixed(4)},asetpts=PTS-STARTPTS,volume=${a.volume.toFixed(3)},adelay=${ms}:all=1[a${i}]`;
  });
  // asetpts=N/SR/TB: with inputs starting at different times amix's timestamps
  // are offset, and the time-based atrim then dropped the opening seconds (a
  // split video's first half went silent). Counting samples restores time 0.
  const mix = `${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:normalize=0:duration=longest,asetpts=N/SR/TB,apad,atrim=0:${duration.toFixed(4)}[aout]`;
  const codec = format === "mp4" ? ["-c:a", "aac", "-b:a", "256k"] : format === "webm" ? ["-c:a", "libopus", "-b:a", "192k"] : ["-c:a", "pcm_s24le"];
  return ["-v", "error", "-y", "-i", video, ...audio.flatMap((a) => ["-i", a.file]), "-filter_complex", [...chains, mix].join(";"), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", ...codec, "-t", duration.toFixed(4), out];
}

function muxAudio(video: string, audio: AudioInput[], duration: number, format: ExportFormat, out: string) {
  const r = spawnSync("ffmpeg", muxArgs(video, audio, duration, format, out), { encoding: "utf8" });
  if (r.status !== 0) {
    renameSync(video, out); // keep the picture even if the sound fails
    throw new Error(`Video exported without sound; audio mix failed: ${r.stderr || r.error?.message}`);
  }
}

/** ffprobe summary used by tests, the engine test and export checks. */
export async function probe(file: string): Promise<{ codec: string; profile?: string; pixFmt: string; width: number; height: number; frames: number; fps: string; hasAlpha: boolean }> {
  const out = await new Promise<string>((res, rej) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,nb_read_frames,r_frame_rate:stream_tags=alpha_mode", "-of", "json", file]);
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
    hasAlpha: /yuva|rgba|argb|bgra|gbrap|pal8/.test(st.pix_fmt) || st.tags?.alpha_mode === "1" || st.tags?.ALPHA_MODE === "1",
  };
}
