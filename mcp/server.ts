#!/usr/bin/env node
/**
 * Local MCP server (stdio) for the Motion Graphics Editor.
 * Started by Claude Code / the Claude desktop app (see `npm run mcp:setup`).
 * It talks to the open editor through the local bridge; nothing leaves the
 * Mac except what a tool returns to Claude.
 *
 * Protocol code is kept to this file + the SDK (PRD risk: MCP keeps evolving).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bridgeInfoFile } from "../scripts/bridge";
import { ROOT } from "../scripts/lib/node-export";
import { closeFrames, contactSheet, renderFrames } from "./frames";
import { BridgePort } from "./port";
import { registerResources, registerTools, SERVER_INSTRUCTIONS } from "./tools";

const port = new BridgePort(bridgeInfoFile(ROOT));
const server = new McpServer({ name: "motion-graphics-editor", version: "0.2.0" }, { instructions: SERVER_INSTRUCTIONS });
registerTools(server, port, renderFrames, contactSheet);
registerResources(server, port);

await server.connect(new StdioServerTransport());
const shutdown = async () => {
  port.close();
  await closeFrames();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
