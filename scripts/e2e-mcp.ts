/**
 * End-to-end test of the Claude connection, the way Claude Code uses it:
 * a real stdio MCP server process, the bridge in the dev server, and the
 * editor in a real browser.     npm run e2e:mcp
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import { launchBrowser, probe, ROOT } from "./lib/node-export";

const out = join(ROOT, "renders/e2e");
mkdirSync(out, { recursive: true });
let failed = 0;
const check = (ok: boolean, msg: string) => (console.log(`${ok ? "PASS" : "FAIL"} ${msg}`), ok || failed++);

const vite = await createServer({ configFile: join(ROOT, "vite.config.ts"), server: { port: 5198, strictPort: false }, logLevel: "error" });
await vite.listen();
const url = vite.resolvedUrls!.local[0];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(() => localStorage.clear());
await page.goto(url);
await page.waitForSelector("[data-testid=claude-status]");
await page.locator(".pname-input").fill("e2e-mcp");

const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "mcp/server.ts")], cwd: "/", stderr: "inherit" }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r;
};
const data = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(name, args)).content[0].text!);

const proj = await data("get_project");
check(proj.compositions[0].layers.length === 5, `get_project reads the open editor (${proj.compositions[0].layers.length} layers)`);
await page.waitForFunction(() => document.querySelector("[data-testid=claude-status]")?.textContent?.includes("connected") && !document.querySelector("[data-testid=claude-status]")?.textContent?.includes("not"));
check(true, "editor shows Claude as connected");

await data("begin_change_set", { name: "Add a kicker" });
const { layerId } = await data("add_layer", { type: "text", name: "Kicker", text: "BREAKING", fontSize: 40, color: "#f97316", position: [200, 780] });
await data("update_layer", { layerId, patch: { style: { align: "left" } } });
await data("set_keyframes", { layerId, path: "transform.opacity", keyframes: [{ time: 0.2, value: 0, easing: "easeOutCubic" }, { time: 0.8, value: 100 }] });
const t0 = Date.now();
const frame = await call("render_frame", { time: 2, scale: 0.5 });
const ms = Date.now() - t0;
writeFileSync(join(out, "mcp-render-frame.png"), Buffer.from(frame.content[0].data!, "base64"));
check(frame.content[0].type === "image", `render_frame returns an image (${ms} ms, target < 3000 incl. browser start)`);
const t1 = Date.now();
await call("render_frame", { time: 1, scale: 1 });
check(Date.now() - t1 < 3000, `warm 1080p render_frame in ${Date.now() - t1} ms`);
const sheet = await call("render_contact_sheet", { count: 6 });
writeFileSync(join(out, "mcp-contact-sheet.png"), Buffer.from(sheet.content[0].data!, "base64"));

await page.waitForSelector(".changeset");
check((await page.locator(".tl-row.layer .lname", { hasText: "Kicker" }).count()) === 1, "Claude's layer appears live in the timeline");
await data("submit_change_set");
await page.screenshot({ path: join(out, "mcp-review.png") });
await page.locator(".changeset button.primary", { hasText: "Keep" }).click();
check((await page.locator(".changeset").count()) === 0, "Keep closes the review card");
await page.keyboard.press("Control+z");
check((await page.locator(".tl-row.layer .lname", { hasText: "Kicker" }).count()) === 0, "one undo removes the kept change set");
await page.keyboard.press("Control+Shift+z");

// Stop button blocks Claude
await page.waitForTimeout(100);
await data("begin_change_set", { name: "Will be stopped" });
await page.locator("[data-testid=claude-stop]").click();
let stopped = false;
try {
  await data("add_layer", { type: "null" });
} catch (e) {
  stopped = /Stopped/.test((e as Error).message);
}
check(stopped, "Stop blocks further edits from Claude");
await page.locator(".claude-activity button", { hasText: "Resume" }).click();

// Export needs approval
const exp = data("export_start", { format: "prores4444" });
await page.waitForSelector("[data-testid=export-approval]");
await page.locator(".modal button.primary", { hasText: "Allow export" }).click();
const job = await exp;
let st: { status: string; done: number; total: number; out: string } = { status: "running", done: 0, total: 0, out: "" };
while (st.status === "running") {
  await new Promise((r) => setTimeout(r, 1000));
  st = await data("export_status", { id: job.id });
}
const pr = st.status === "done" ? await probe(st.out) : null;
check(!!pr && pr.hasAlpha && pr.codec === "prores", `approved export finished: ${st.status} ${pr ? `${pr.pixFmt} ${pr.frames} frames` : ""}`);

check(errors.length === 0, `no browser errors ${errors.join(" | ")}`);
await client.close();
await browser.close();
await vite.close();
console.log(failed ? `${failed} check(s) failed` : "All MCP checks passed.");
process.exit(failed ? 1 : 0);
