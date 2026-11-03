/**
 * End-to-end test of the Mac app (ED-26) through Playwright's Electron driver.
 *   npm run e2e:app      (builds first; on Linux CI it needs a display, e.g. xvfb-run)
 * Checks: the window opens on the built UI, the native bridge is present,
 * menus drive the editor, files "opened from Finder" import, a project.json
 * from anywhere is adopted into projects/, and closing flushes the autosave.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import { lowerThirdProject } from "../src/core/samples";
import { makeProject } from "../src/core/factory";
import { serializeProject } from "../src/core/project-io";
import { ROOT } from "./lib/node-export";

const out = join(ROOT, "renders/e2e");
const tmp = join(ROOT, ".cache/e2e-app");
mkdirSync(out, { recursive: true });
rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(tmp, "elsewhere/assets"), { recursive: true });
rmSync(join(ROOT, "projects/elsewhere"), { recursive: true, force: true });
rmSync(join(ROOT, "projects/e2e-app"), { recursive: true, force: true });

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

const app = await electron.launch({
  args: [ROOT, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  cwd: ROOT,
  env: { ...process.env, MGE_ROOT: ROOT, NODE_OPTIONS: "" },
  timeout: 60_000,
});
const page = await app.firstWindow();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
await page.waitForSelector("[data-testid=viewer] svg", { timeout: 30_000 });

const click = (id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id);
const layerCount = () => page.locator(".tl-row.layer").count();

check(await page.evaluate(() => typeof (window as { mgeNative?: unknown }).mgeNative === "object"), "the page sees the native bridge (window.mgeNative)");
check(await page.evaluate(() => typeof (window as { require?: unknown }).require === "undefined"), "the page has no Node access");

// Start from a clean project in our own folder, so the run never autosaves
// over or renames one of kp's projects.
mkdirSync(join(ROOT, "projects/e2e-app"), { recursive: true });
writeFileSync(join(ROOT, "projects/e2e-app/project.json"), serializeProject(makeProject("e2e-app")));
await page.evaluate(() => localStorage.setItem("mge:last", "e2e-app"));
await page.reload();
await page.waitForFunction(() => (document.querySelector(".pname-input") as HTMLInputElement)?.value === "e2e-app", null, { timeout: 30_000 });
await page.waitForTimeout(300);
const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
check(title.startsWith("e2e-app"), `window title follows the project ("${title}")`);

const n0 = await layerCount();
await click("add:solid");
check((await layerCount()) === n0 + 1, "Layer › New Solid adds a layer");
await page.waitForTimeout(200);
const undoEnabled = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("undo")!.enabled);
check(undoEnabled, "Edit › Undo is enabled after an edit");
await click("undo");
check((await layerCount()) === n0, "Edit › Undo removes it");
await click("redo");
await page.locator(".tl-row.layer .lname", { hasText: "Solid" }).first().click();
await click("precompose");
check((await page.locator(".tl-row.layer .lname", { hasText: "comp" }).count()) === 1, "Composition › Precompose works on the selection");
await click("comp-settings");
check(await page.locator(".modal").isVisible(), "Composition › Settings opens the dialog");
await page.keyboard.press("Escape");
await page.locator(".modal button", { hasText: /Cancel|Close/ }).first().click().catch(() => undefined);

// A PNG "opened from Finder" (drop on the Dock icon / Open With).
const png = join(tmp, "dot.png");
writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const n1 = await layerCount();
await app.evaluate(({ app }, p) => app.emit("open-file", { preventDefault() {} }, p), png);
await page.waitForFunction((n) => document.querySelectorAll(".tl-row.layer").length === n + 1, n1, { timeout: 10_000 }).catch(() => undefined);
check((await page.locator(".tl-row.layer .lname", { hasText: "dot.png" }).count()) === 1, "a PNG opened from Finder becomes an image layer");
check(existsSync(join(ROOT, "projects/e2e-app/assets/dot.png")), "its file is copied into the project's assets");
await page.screenshot({ path: join(out, "app-01.png") });

// A project.json from another folder, with its assets.
const p = structuredClone(lowerThirdProject("Elsewhere"));
writeFileSync(join(tmp, "elsewhere/project.json"), serializeProject(p));
copyFileSync(png, join(tmp, "elsewhere/assets/keep.png"));
await app.evaluate(({ app }, f) => app.emit("open-file", { preventDefault() {} }, f), join(tmp, "elsewhere/project.json"));
await page.waitForFunction(() => (document.querySelector(".pname-input") as HTMLInputElement)?.value === "elsewhere", null, { timeout: 10_000 }).catch(() => undefined);
check((await page.locator(".pname-input").inputValue()) === "elsewhere", "a project.json from another folder opens");
check(existsSync(join(ROOT, "projects/elsewhere/assets/keep.png")), "and is copied into projects/ with its assets");

// Export runs inside the app's own server (Chrome + FFmpeg).
await click("save-version");
await page.waitForTimeout(500);
const job = await page.evaluate(async () => {
  const r = await fetch("/api/export?name=elsewhere", { method: "POST", body: JSON.stringify({ format: "gif", fps: 10, width: 320 }) });
  const { id, out } = await r.json();
  for (let i = 0; i < 240; i++) {
    const s = await (await fetch(`/api/export/status?id=${id}`)).json();
    if (s.status !== "running") return { ...s, out };
    await new Promise((res) => setTimeout(res, 500));
  }
  return { status: "timeout", out };
});
check(job.status === "done" && existsSync(job.out), `GIF export from the app finished (${job.status}${job.error ? ": " + job.error : ""})`);
if (existsSync(job.out)) rmSync(job.out);

// Closing the window writes the autosave first.
await click("add:null");
const f = join(ROOT, "projects/elsewhere/project.json");
const before = statSync(f).mtimeMs;
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
await new Promise((r) => setTimeout(r, 2500));
const saved = JSON.parse(readFileSync(f, "utf8"));
check(statSync(f).mtimeMs > before && saved.compositions[0].layers.some((l: { type: string }) => l.type === "null"), "closing the window saves the latest edit");

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await app.close();
rmSync(join(ROOT, "projects/elsewhere"), { recursive: true, force: true });
rmSync(join(ROOT, "projects/e2e-app"), { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed` : "All app checks passed.");
process.exit(failed ? 1 : 0);
