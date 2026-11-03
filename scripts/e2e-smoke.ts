/**
 * End-to-end smoke test of the editor in a real browser (Playwright).
 *   npm run e2e            -> screenshots in renders/e2e/
 * Starts its own Vite dev server on a free port.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
await page.addInitScript(() => (localStorage.clear(), localStorage.setItem("mge:last", "e2e-test")));
await page.goto(url);
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

// save to the local project store
await page.locator(".viewer").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Control+s");
await page.waitForTimeout(800);
const saved = await (await fetch(`${url}api/project?name=e2e-test`)).json();
check(saved.format === "mge-project" && saved.compositions[0].fps === 25, "project saves to projects/e2e-test/project.json");

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
for (const n of ["e2e-renamed", "e2e-taken"]) rmSync(join(ROOT, "projects", n), { recursive: true, force: true });

await page.screenshot({ path: join(out, "03-edited.png") });
check(errors.length === 0, `no browser errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close();
await server.close();
rmSync(join(ROOT, "projects/e2e-test"), { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed` : "All checks passed. Screenshots in renders/e2e/");
process.exit(failed ? 1 : 0);
