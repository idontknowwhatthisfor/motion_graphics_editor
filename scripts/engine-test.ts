/**
 * Engine test (PRD "Test before committing"). Run on the Mac with the Claude
 * app open:   npm run engine-test            (add -- --skip-hyperframes to
 * test only the direct exporter)
 *
 * 1. Renders a 15 s, 1080p, 30-layer transparent overlay as ProRes 4444.
 * 2. Records peak memory and render time.
 * 3. Checks the file with ffprobe (then YOU import it into Resolve).
 * 4. Confirms one keyframe edit in the JSON changes the rendered frame.
 * Writes renders/engine-test/REPORT.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "../src/core/editor";
import { engineTestProject } from "../src/core/samples";
import { exportDirect, launchBrowser, openComposition, probe, ROOT, writeHyperFramesProject, seekAndShoot } from "./lib/node-export";
import { mb, measureSelf, runMeasured } from "./lib/measure";

const HYPERFRAMES_VERSION = "0.9.4"; // pinned (PRD risk: engine changes quickly)
const outDir = join(ROOT, "renders/engine-test");
mkdirSync(outDir, { recursive: true });
const skipHF = process.argv.includes("--skip-hyperframes");
const lines: string[] = [`# Engine test report`, ``, `Run: ${new Date().toISOString()} on ${process.platform}/${process.arch}`, ``];
const log = (s: string) => (console.log(s), lines.push(s));

const project = engineTestProject();
const hfDir = join(outDir, "hyperframes-project");
writeHyperFramesProject(project, ROOT, hfDir);
log(`Compiled 30-layer test composition to ${hfDir}`);

async function check(label: string, file: string, ms: number, peak: number) {
  try {
    const p = await probe(file);
    const ok = p.codec === "prores" && p.hasAlpha && p.frames === 450 && p.width === 1920;
    log(`\n## ${label}: ${ok ? "PASS" : "CHECK"}`);
    log(`- file: ${file}`);
    log(`- render time: ${(ms / 1000).toFixed(1)} s (target under 300 s)`);
    log(`- peak memory of render process tree: ${mb(peak)}`);
    log(`- ffprobe: ${p.codec} ${p.profile ?? ""}, ${p.pixFmt}, ${p.width}x${p.height}, ${p.frames} frames @ ${p.fps}, alpha=${p.hasAlpha}`);
  } catch (e) {
    log(`\n## ${label}: FAIL (${(e as Error).message})`);
  }
}

// 1–3a. HyperFrames
if (!skipHF) {
  const file = join(outDir, "hyperframes.mov");
  log(`\nRendering with HyperFrames ${HYPERFRAMES_VERSION} (first run downloads it)...`);
  const r = await runMeasured("npx", ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "render", "--format", "mov", "--quality", "delivery", "-o", file], { cwd: hfDir });
  if (r.code !== 0) log(`\n## HyperFrames: FAIL (exit ${r.code})\n\n\`\`\`\n${r.output.slice(-3000)}\n\`\`\``);
  else await check("HyperFrames ProRes 4444", file, r.ms, r.peakBytes);
}

// 1–3b. Direct exporter (Playwright + FFmpeg)
{
  const file = join(outDir, "direct.mov");
  log(`\nRendering with the direct exporter...`);
  const r = await measureSelf(() => exportDirect(project, ROOT, undefined, { format: "prores4444", out: file }));
  await check("Direct exporter ProRes 4444", file, r.ms, r.peakBytes);
}

// 4. One keyframe edit changes the rendered frame
{
  const ed = new Editor(project);
  const layer = ed.project.compositions[0].layers.find((l) => l.type === "shape")!;
  const browser = await launchBrowser();
  const shoot = async (dir: string) => {
    const page = await openComposition(browser, dir, 1920, 1080);
    const png = await seekAndShoot(page, 5);
    await page.context().close();
    return png;
  };
  const a = await shoot(hfDir);
  ed.must({ type: "prop.set", layerId: layer.id, path: "transform.position", value: [400, 900] });
  const editedDir = join(outDir, "edited-project");
  writeHyperFramesProject(ed.project, ROOT, editedDir);
  const b = await shoot(editedDir);
  await browser.close();
  writeFileSync(join(outDir, "frame-before.png"), a);
  writeFileSync(join(outDir, "frame-after.png"), b);
  log(`\n## Keyframe edit changes the frame: ${a.equals(b) ? "FAIL" : "PASS"}`);
}

log(`\n## Your part\nImport the .mov files into DaVinci Resolve over a coloured clip and check transparency and clean edges.`);
log(`If edges look fringed, set Clip Attributes > Alpha Mode to "Straight" and compare with "Premultiplied".`);
writeFileSync(join(outDir, "REPORT.md"), lines.join("\n") + "\n");
console.log(`\nReport: ${join(outDir, "REPORT.md")}`);
