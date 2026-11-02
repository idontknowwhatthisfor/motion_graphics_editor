/**
 * CL-01: register the local MCP server with Claude Code and the Claude
 * desktop app on this Mac.   npm run mcp:setup   (add -- --dry-run to preview)
 *
 * Both apps launch: <node> <tsx cli> <repo>/mcp/server.ts  over stdio.
 * Absolute paths are used because the desktop app does not inherit your
 * shell PATH. Re-run after moving the folder or changing Node versions.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "./lib/node-export";

const NAME = "motion-graphics";
const dry = process.argv.includes("--dry-run");
const command = process.execPath;
const args = [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "mcp/server.ts")];
if (!existsSync(args[0])) throw new Error("Run `npm install` first");
console.log(`MCP server command:\n  ${[command, ...args].map((a) => JSON.stringify(a)).join(" ")}\n`);

// Claude Code (user scope, so it works from any folder)
const hasClaude = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
if (!hasClaude) {
  console.log("Claude Code: `claude` not found on PATH. To add it later run:");
  console.log(`  claude mcp add -s user ${NAME} -- ${[command, ...args].map((a) => JSON.stringify(a)).join(" ")}\n`);
} else if (dry) {
  console.log(`Claude Code: would run  claude mcp add -s user ${NAME} -- …\n`);
} else {
  spawnSync("claude", ["mcp", "remove", "-s", "user", NAME], { stdio: "ignore" });
  const r = spawnSync("claude", ["mcp", "add", "-s", "user", NAME, "--", command, ...args], { stdio: "inherit" });
  console.log(r.status === 0 ? "Claude Code: registered.\n" : "Claude Code: registration failed (see above).\n");
}

// Claude desktop app
const desktopConfig =
  platform() === "darwin"
    ? join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json")
    : join(homedir(), ".config/Claude/claude_desktop_config.json");
if (!existsSync(dirname(desktopConfig))) {
  console.log(`Claude desktop app: not installed (no ${dirname(desktopConfig)}). Skipped.`);
} else {
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(desktopConfig)) {
    cfg = JSON.parse(readFileSync(desktopConfig, "utf8"));
    if (!dry) copyFileSync(desktopConfig, `${desktopConfig}.bak-${Date.now()}`);
  }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [NAME]: { command, args } };
  if (dry) console.log(`Claude desktop app: would write ${desktopConfig}:\n${JSON.stringify(cfg, null, 2)}`);
  else {
    mkdirSync(dirname(desktopConfig), { recursive: true });
    writeFileSync(desktopConfig, JSON.stringify(cfg, null, 2));
    console.log(`Claude desktop app: registered in ${desktopConfig} (a backup was saved next to it). Quit and reopen the app.`);
  }
}
// CL-12: the bundled skill (project format + motion conventions).
const skillSrc = join(ROOT, "skill/motion-graphics-editor");
const skillDst = join(homedir(), ".claude/skills/motion-graphics-editor");
if (dry) console.log(`\nSkill: would copy ${skillSrc} to ${skillDst}`);
else {
  rmSync(skillDst, { recursive: true, force: true });
  mkdirSync(dirname(skillDst), { recursive: true });
  cpSync(skillSrc, skillDst, { recursive: true });
  console.log(`\nSkill: installed for Claude Code in ${skillDst}`);
  if (platform() === "darwin") {
    const zip = join(ROOT, "renders/motion-graphics-editor-skill.zip");
    mkdirSync(dirname(zip), { recursive: true });
    rmSync(zip, { force: true });
    if (spawnSync("ditto", ["-c", "-k", "--keepParent", skillSrc, zip]).status === 0)
      console.log(`Skill: for the Claude desktop app, upload ${zip} in Settings › Capabilities › Skills.`);
  }
}

console.log("\nThen: keep the editor open (`npm run dev`) and ask Claude, e.g. “Using motion-graphics, build a lower third with my name”.");
