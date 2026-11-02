/**
 * Frame checks for Claude (CL-05): renders frames with the SAME compiled
 * HyperFrames page the exporter uses, in a warm headless Chrome.
 */
import { join } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, openComposition, ROOT, seekAndShoot, writeHyperFramesProject } from "../scripts/lib/node-export";
import type { Project } from "../src/core/types";

let browser: Browser | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

async function getBrowser() {
  clearTimeout(idleTimer);
  // Close Chrome after 2 idle minutes: memory matters on an 8 GB Mac.
  idleTimer = setTimeout(() => {
    browser?.close().catch(() => undefined);
    browser = null;
  }, 120_000);
  if (!browser || !browser.isConnected()) browser = await launchBrowser();
  return browser;
}

export type FrameBackground = "checker" | "transparent" | string;

/** Render frames at the given times. Returns PNG buffers. */
export async function renderFrames(project: Project, projectDir: string, compId: string, times: number[], scale: number, background: FrameBackground = "checker"): Promise<Buffer[]> {
  const comp = project.compositions.find((c) => c.id === compId) ?? project.compositions[0];
  const dir = join(ROOT, ".cache", "mcp-frames");
  writeHyperFramesProject(project, projectDir, dir, comp.id, { fps: comp.fps });
  const b = await getBrowser();
  const page = await openComposition(b, dir, comp.width, comp.height, scale);
  try {
    if (background !== "transparent") {
      const css =
        background === "checker"
          ? "background-color:#9ca3af;background-image:linear-gradient(45deg,#6b7280 25%,transparent 25%),linear-gradient(-45deg,#6b7280 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#6b7280 75%),linear-gradient(-45deg,transparent 75%,#6b7280 75%);background-size:40px 40px;background-position:0 0,0 20px,20px -20px,-20px 0"
          : `background:${background.replace(/[^#a-zA-Z0-9(),.% ]/g, "")}`;
      await page.evaluate((c) => document.getElementById("root")!.setAttribute("style", c), css);
    }
    const out: Buffer[] = [];
    for (const t of times) out.push(await seekAndShoot(page, Math.max(0, Math.min(comp.duration - 1 / comp.fps, t))));
    return out;
  } finally {
    await page.context().close();
  }
}

/** Lay out frames in a labelled grid and return one PNG. */
export async function contactSheet(frames: Buffer[], labels: string[], cellW: number, cellH: number): Promise<Buffer> {
  const cols = Math.ceil(Math.sqrt(frames.length));
  const rows = Math.ceil(frames.length / cols);
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: cols * (cellW + 8) + 8, height: rows * (cellH + 28) + 8 } });
  const page = await ctx.newPage();
  const cells = frames
    .map((f, i) => `<figure><img src="data:image/png;base64,${f.toString("base64")}" width="${cellW}" height="${cellH}"><figcaption>${labels[i]}</figcaption></figure>`)
    .join("");
  await page.setContent(
    `<style>body{margin:0;padding:4px;background:#111;display:grid;grid-template-columns:repeat(${cols},${cellW + 8}px);font:12px system-ui;color:#ddd}figure{margin:4px}img{display:block}figcaption{padding:2px 0}</style>${cells}`,
  );
  await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode())));
  const png = await page.screenshot({ type: "png", fullPage: true });
  await ctx.close();
  return png;
}

export async function closeFrames() {
  await browser?.close().catch(() => undefined);
  browser = null;
}
