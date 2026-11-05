/**
 * End-to-end smoke test of the editor in a real browser (Playwright).
 *   npm run e2e            -> screenshots in renders/e2e/
 * Starts its own Vite dev server on a free port.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import { launchBrowser, ROOT } from "./lib/node-export";
import { serializeProject } from "../src/core/project-io";
import { lowerThirdProject } from "../src/core/samples";

const out = join(ROOT, "renders/e2e");
mkdirSync(out, { recursive: true });
const server = await createServer({ configFile: join(ROOT, "vite.config.ts"), server: { port: 5199, strictPort: false }, logLevel: "error" });
await server.listen();
const url = server.resolvedUrls!.local[0];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

// Work in our own project folder (the sample, saved as e2e-test) so the run
// never autosaves over or renames one of kp's projects.
for (const n of ["e2e-test", "e2e-renamed", "e2e-taken"]) rmSync(join(ROOT, "projects", n), { recursive: true, force: true });
for (const n of ["e2e-test", "e2e-taken"]) await fetch(`${url}api/project?name=${n}`, { method: "PUT", body: serializeProject(lowerThirdProject()) });
await page.addInitScript(() => localStorage.clear());
const listed = async () => (await (await fetch(`${url}api/projects`)).json()) as { name: string; modified: number }[];
const atStart = await listed();
await page.goto(url);

// startup: the project list, and nothing saved until a project is chosen
await page.waitForSelector("[data-testid=home] .card[data-project=e2e-test] .thumb-svg svg");
check((await page.locator(".app").count()) === 0, "the app starts on the project list, not in the editor");
check((await page.locator(".card[data-project=e2e-test] .thumb-svg [data-layer]").count()) >= 4, "project cards show a rendered thumbnail");
await page.waitForTimeout(6000); // longer than the 5 s autosave
check(JSON.stringify(await listed()) === JSON.stringify(atStart), "waiting on the project list saves nothing");
await page.locator(".home-search").fill("e2e-tak");
check((await page.locator(".card").count()) === 1, "search filters the project list");
await page.locator(".home-search").fill("");
await page.locator(".home-new-name").fill("e2e-taken");
await page.locator(".home-new button.primary").click();
await page.waitForTimeout(500);
check((await page.locator("[data-testid=home]").count()) === 1, "New project refuses a name that is taken");
await page.locator(".card[data-project=e2e-test]").click();
await page.waitForFunction(() => (document.querySelector(".pname-input") as HTMLInputElement)?.value === "e2e-test");
await page.waitForSelector("[data-testid=viewer] svg [data-layer]", { state: "attached" }); // opened at t = 0, where the sample is still transparent
const layers = await page.locator(".stage [data-layer]").count();
check(layers >= 4, `sample renders ${layers} layers`);
await page.screenshot({ path: join(out, "01-start.png") });

// select a layer by clicking its name in the timeline, expand it, open graph
await page.locator(".tl-row.layer .lname", { hasText: "Name" }).click();
check((await page.locator("[data-testid=inspector] .section-head").first().textContent())!.includes("Name"), "selecting a layer fills the inspector");
await page.locator(".tl-row.layer.sel .twisty").click();
await page.locator(".tl-row.prop .pname", { hasText: "Opacity" }).first().click();
check(await page.locator("[data-testid=graph-editor] .g-curve").isVisible(), "graph editor shows the opacity curve");
await page.screenshot({ path: join(out, "02-graph.png") });

// draw a rectangle with the rectangle tool
const before = await page.locator(".tl-row.layer").count();
await page.keyboard.press("r");
const vb = (await page.locator(".stage-frame").boundingBox())!;
await page.mouse.move(vb.x + vb.width * 0.6, vb.y + vb.height * 0.15);
await page.mouse.down();
await page.mouse.move(vb.x + vb.width * 0.8, vb.y + vb.height * 0.35, { steps: 5 });
await page.mouse.up();
check((await page.locator(".tl-row.layer").count()) === before + 1, "rectangle tool adds a shape layer");

// move it with the select tool, then undo the move
const sel = await page.locator(".tl-row.layer.sel .lname").textContent();
await page.mouse.move(vb.x + vb.width * 0.7, vb.y + vb.height * 0.25);
await page.mouse.down();
await page.mouse.move(vb.x + vb.width * 0.5, vb.y + vb.height * 0.5, { steps: 8 });
await page.mouse.up();
const posAfter = await page.locator(".prow", { hasText: "Position" }).first().locator("input").first().inputValue();
await page.keyboard.press("Control+z");
const posUndo = await page.locator(".prow", { hasText: "Position" }).first().locator("input").first().inputValue();
check(posAfter !== posUndo, `drag moves "${sel}" and one undo restores it (${posAfter} -> ${posUndo})`);

// keyframe via stopwatch + timeline scrub
await page.keyboard.press("Home");
await page.locator(".inspector .prow", { hasText: "Rotation" }).locator(".stopwatch").click();
check((await page.locator(".tl-row.prop .kf").count()) > 0, "stopwatch adds a keyframe");

// pen tool: three clicks + Enter
await page.keyboard.press("p");
for (const [fx, fy] of [[0.2, 0.2], [0.35, 0.1], [0.45, 0.3]]) await page.mouse.click(vb.x + vb.width * fx, vb.y + vb.height * fy);
await page.keyboard.press("Enter");
check((await page.locator(".tl-row.layer .lname", { hasText: "Pen path" }).count()) === 1, "pen tool creates a path layer");

// effects: add a blur to the new path layer (ED-11)
await page.locator("[data-testid=add-effect]").selectOption("blur");
check((await page.locator(".inspector .prow", { hasText: "Amount" }).count()) === 1 && (await page.locator(".viewer svg [filter]").count()) > 0, "adding a blur effect shows its controls and an SVG filter");

// expressions (ED-12) and repeaters (ED-09) on the path layer
await page.locator(".inspector .prow", { hasText: "Rotation" }).locator(".expr-btn").click();
await page.locator(".inspector .expr textarea").fill("wiggle(2, 15)");
await page.locator(".inspector .expr textarea").blur();
check((await page.locator(".inspector .expr-foot", { hasText: "=" }).count()) === 1 && (await page.locator(".inspector .expr-btn.on").count()) === 1, "an expression applies and shows its live value");
await page.locator(".inspector button", { hasText: "+ Repeater" }).click();
check((await page.locator(".inspector .prow", { hasText: "Copies" }).count()) === 1, "a repeater can be added from the Inspector");

// nested comps: precompose the selected layer (ED-02)
await page.keyboard.press("Control+Shift+c");
check((await page.locator(".tl-row.layer .lname", { hasText: "Pen path comp" }).count()) === 1 && (await page.locator(".inspector .section-head", { hasText: "Nested comp" }).count()) === 1, "precompose replaces the layer with a nested comp");
await page.screenshot({ path: join(out, "02b-effects-precomp.png") });

// brand kit (ED-15): apply the default kit, swatches appear on colour rows
await page.locator(".topbar button", { hasText: "Brand" }).click();
await page.locator("[data-testid=brand-dialog]").waitFor();
await page.locator(".modal button.primary").click();
await page.locator(".tl-row.layer .lname", { hasText: "Rectangle" }).first().click();
check((await page.locator(".inspector .swatch").count()) > 0, "a brand kit adds colour swatches to the Inspector");

// template fields (ED-16)
await page.locator(".topbar button", { hasText: "Template" }).click();
const tpl = page.locator("[data-testid=template-dialog]");
await tpl.locator("select").first().selectOption({ label: "Rectangle" });
await tpl.locator("select").nth(1).selectOption("fill.paint.color");
await tpl.locator("input[placeholder='Field name']").fill("Accent");
await tpl.locator("button", { hasText: "+ Field" }).click();
check((await tpl.locator("input[type=color]").count()) === 1, "a template field can be added and filled");
await page.locator(".modal-head button").click();

// composition settings: change fps
await page.keyboard.press("Control+k");
await page.locator(".modal label", { hasText: "Frame rate" }).locator("input").fill("25");
await page.locator(".modal button.primary").click();
check((await page.locator(".viewer-info").textContent())!.includes("25 fps"), "comp settings change the frame rate");

// importing a video with sound adds a linked audio layer; one without sound does not
const media = join(ROOT, ".cache/e2e-media");
mkdirSync(media, { recursive: true });
const ff = (...a: string[]) => spawnSync("ffmpeg", ["-v", "error", "-y", ...a]).status === 0;
const made =
  ff("-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2:r=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(media, "with-sound.mp4")) &&
  ff("-f", "lavfi", "-i", "color=c=red:s=320x180:d=2:r=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(media, "silent.mp4"));
check(made, "test videos made with FFmpeg");
const rowsNamed = (n: string) => page.locator(".tl-row.layer", { has: page.locator(".lname", { hasText: n }) });
await page.locator("input[type=file]").first().setInputFiles(join(media, "with-sound.mp4"));
await rowsNamed("with-sound.mp4 (sound)").waitFor({ timeout: 15_000 });
check((await rowsNamed("with-sound.mp4").locator("button.link.on").count()) === 2, "a video with sound imports as a linked video + sound pair");
await page.locator("input[type=file]").first().setInputFiles(join(media, "silent.mp4"));
await rowsNamed("silent.mp4").waitFor({ timeout: 15_000 });
await page.waitForTimeout(500);
check((await rowsNamed("silent.mp4").count()) === 1 && (await rowsNamed("silent.mp4").locator("button.link.on").count()) === 0, "a video without sound imports as one video layer");

// a clip longer than the comp stretches the comp to fit; one undo takes both back
const compDuration = async () => {
  await page.keyboard.press("Control+k");
  const v = Number(await page.locator(".modal label", { hasText: "Duration" }).locator("input").inputValue());
  await page.locator(".modal-head button").click();
  return v;
};
check(ff("-f", "lavfi", "-i", "color=c=green:s=64x36:d=40:r=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(media, "long.mp4")), "long test video made with FFmpeg");
const durBefore = await compDuration();
await page.locator("input[type=file]").first().setInputFiles(join(media, "long.mp4"));
await rowsNamed("long.mp4").waitFor({ timeout: 15_000 });
const durAfter = await compDuration();
check(durBefore < 40 && Math.abs(durAfter - 40) < 0.2, `importing a 40 s clip stretches the comp to fit (${durBefore} s -> ${durAfter} s)`);
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check((await rowsNamed("long.mp4").count()) === 0 && (await compDuration()) === durBefore, "one undo removes the clip and restores the comp length");
await rowsNamed("with-sound.mp4 (sound)").locator("button.link.on").click();
check((await rowsNamed("with-sound.mp4").locator("button.link.on").count()) === 0, "the link icon unlinks the pair");
await page.keyboard.press("Control+z");
check((await rowsNamed("with-sound.mp4").locator("button.link.on").count()) === 2, "undo relinks them");
await rowsNamed("silent.mp4").locator(".lname").click();
await rowsNamed("with-sound.mp4 (sound)").locator(".lname").click({ modifiers: ["Shift"] });
await rowsNamed("silent.mp4").locator("button.link").click();
check((await rowsNamed("silent.mp4").locator("button.link.on").count()) === 1, "the grey link icon links the selected layers");

// save to the local project store
await page.locator(".viewer").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Control+s");
await page.waitForTimeout(800);
const saved = await (await fetch(`${url}api/project?name=e2e-test`)).json();
check(saved.format === "mge-project" && saved.compositions[0].fps === 25, "project saves to projects/e2e-test/project.json");

// Fusion export from the dialog: a .comp/.setting folder, with the flattened layers listed
await page.locator(".topbar button.primary", { hasText: "Export" }).click();
await page.locator(".modal select").selectOption("fusion");
await page.locator(".modal label", { hasText: "Frame rate" }).locator("input").fill("5"); // few frames to render
await page.locator(".modal label", { hasText: "Width" }).locator("input").fill("480");
await page.locator(".modal-foot button.primary", { hasText: "Export" }).click();
await page.locator("[data-testid=export-notes]").waitFor({ timeout: 180_000 });
const fusionOut = (await page.locator(".modal .small", { hasText: "Saved to" }).innerText()).replace(/^Saved to\s*/, "").replace(/\s*Show in Finder$/, "").trim();
const fusionFiles = existsSync(fusionOut) ? readdirSync(fusionOut) : [];
check(fusionFiles.some((f) => f.endsWith(".comp")) && fusionFiles.some((f) => f.endsWith(".setting")) && fusionFiles.includes("README.txt"), `Fusion export writes .comp, .setting and README (${fusionFiles.join(", ")})`);
const notesText = await page.locator("[data-testid=export-notes]").innerText();
check(/rendered to PNG frames because of/.test(notesText), "the export dialog lists the flattened layers");
const comp = existsSync(fusionOut) ? readFileSync(join(fusionOut, fusionFiles.find((f) => f.endsWith(".comp"))!), "utf8") : "";
check(/MediaOut1 = MediaOut/.test(comp) && /Width = Input \{ Value = 480 \}/.test(comp), "the .comp has a MediaOut and the chosen export size");
await page.screenshot({ path: join(out, "02c-fusion-export.png") });
rmSync(fusionOut, { recursive: true, force: true });
await page.locator(".modal-head button").click();

// rename: typing slower than the 5 s autosave must not create a folder per keystroke
await page.keyboard.press("Control+k");
await page.locator(".modal label", { hasText: "Frame rate" }).locator("input").fill("30");
await page.locator(".modal button.primary").click(); // unsaved change, so the autosave is due
const nameBox = page.locator(".pname-input");
await nameBox.fill("");
await nameBox.pressSequentially("e2e-renamed", { delay: 600 });
await nameBox.press("Enter");
await page.waitForTimeout(800);
const partial = readdirSync(join(ROOT, "projects")).filter((n) => "e2e-renamed".startsWith(n) && n !== "e2e-renamed");
check(partial.length === 0, `typing a name leaves no half-typed folders${partial.length ? ": " + partial.join(", ") : ""}`);
check(!existsSync(join(ROOT, "projects/e2e-test")) && existsSync(join(ROOT, "projects/e2e-renamed/versions")), "Enter moves the folder, versions included");
await nameBox.fill("e2e-taken");
await nameBox.press("Enter");
await page.waitForTimeout(500);
check((await nameBox.inputValue()) === "e2e-renamed" && existsSync(join(ROOT, "projects/e2e-renamed/project.json")), "renaming to a taken name is refused");

// Projects returns to the list, which now leads with this project
await page.locator(".topbar button", { hasText: "Projects" }).click();
await page.waitForSelector("[data-testid=home] .card");
check((await page.locator(".card").first().getAttribute("data-project")) === "e2e-renamed" && (await page.locator(".card .badge").count()) === 1,
  "Projects goes back to the list with this project first, marked Last opened");
for (const n of ["e2e-renamed", "e2e-taken"]) rmSync(join(ROOT, "projects", n), { recursive: true, force: true });

await page.screenshot({ path: join(out, "03-edited.png") });
check(errors.length === 0, `no browser errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close();
await server.close();
rmSync(join(ROOT, "projects/e2e-test"), { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed` : "All checks passed. Screenshots in renders/e2e/");
process.exit(failed ? 1 : 0);
