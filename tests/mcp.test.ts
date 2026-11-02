import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/core/editor";
import { makeProject } from "../src/core/factory";
import { evaluateComposition } from "../src/core/evaluate";
import { LocalPort } from "../mcp/port";
import { registerResources, registerTools, SERVER_INSTRUCTIONS } from "../mcp/tools";

let editor: Editor;
let port: LocalPort;
let client: Client;
const fakePng = Buffer.from("89504e470d0a1a0a", "hex");

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
  const text = r.content.find((c) => c.type === "text")?.text;
  if (r.isError) throw new Error(text);
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return r;
  }
}

beforeEach(async () => {
  editor = new Editor(makeProject("MCP test"));
  port = new LocalPort(editor);
  const server = new McpServer({ name: "t", version: "0" }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, port, async (_p, _d, _c, times) => times.map(() => fakePng), async () => fakePng);
  registerResources(server, port);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

describe("MCP tools", () => {
  it("keeps the tool set small", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(20);
    expect(tools.length).toBeLessThanOrEqual(30);
  });

  it("builds a lower third as one reviewable change set", async () => {
    await call("begin_change_set", { name: "Lower third" });
    const { layerId: bar } = await call("add_layer", { type: "shape", name: "Bar", position: [500, 900], size: [800, 120], color: "#111827" });
    const { layerId: title } = await call("add_layer", { type: "text", text: "Ada Lovelace", position: [140, 910], fontSize: 64 });
    await call("update_layer", { layerId: title, patch: { style: { align: "left" } } });
    await call("set_keyframes", { layerId: bar, path: "transform.scale", keyframes: [{ time: 0, value: [0, 100], easing: "easeOutExpo" }, { time: 0.4, value: [100, 100] }] });
    await call("add_text_animator", { layerId: title, preset: "slideUp", reveal: { start: 0.3, duration: 0.6, easing: "easeOutCubic" } });
    const sub = await call("submit_change_set");
    expect(sub.status).toBe("pending");
    expect(editor.past.length).toBe(0); // nothing merged until the user keeps it
    const cs = editor.changeSets[0];
    expect(cs.layerIds).toEqual(expect.arrayContaining([bar, title]));
    const mid = evaluateComposition(editor.project, editor.project.compositions[0], 0.2);
    expect(mid.layers.find((l) => l.id === bar)!.matrix[0]).toBeGreaterThan(0.5); // expo ease: fast start
    editor.rejectChangeSet(cs.id);
    expect(editor.project.compositions[0].layers.length).toBe(0);
  });

  it('resolves "selected" to the user selection (CL-08)', async () => {
    const { layerId } = await call("add_layer", { type: "shape" });
    await call("set_keyframes", { layerId, path: "transform.position", keyframes: [{ time: 0, value: [0, 0] }, { time: 1, value: [100, 0] }] });
    port.selection = [layerId];
    await call("apply_easing", { layerIds: ["selected"], easing: "easeOutBack" });
    const kfs = editor.project.compositions[0].layers[0].transform.position.keyframes!;
    expect(kfs[0].ease).toMatchObject({ kind: "bezier", y1: 1.56 });
    port.selection = [];
    await expect(call("apply_easing", { layerIds: ["selected"], easing: "linear" })).rejects.toThrow(/Nothing is selected/);
  });

  it("errors come back as tool errors and change nothing", async () => {
    const { layerId } = await call("add_layer", { type: "shape" });
    const before = editor.project;
    await expect(call("set_property", { layerId, path: "transform.position", value: "#ff0000" })).rejects.toThrow(/must be a vec2/);
    expect(editor.project).toBe(before);
    await expect(call("batch", { commands: [{ type: "project.setPermissionMode", mode: "autoKeep" }] })).rejects.toThrow(/not available/);
  });

  it("read-only mode refuses Claude's edits", async () => {
    editor.must({ type: "project.setPermissionMode", mode: "readOnly" });
    await expect(call("add_layer", { type: "null" })).rejects.toThrow(/Read only/);
  });

  it("stagger, sequence, variants and batch", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await call("add_layer", { type: "shape", outPoint: 2 })).layerId);
    await call("stagger", { layerIds: ids, step: 0.25, start: 1 });
    const L = () => editor.project.compositions[0].layers;
    expect(ids.map((id) => L().find((l) => l.id === id)!.inPoint)).toEqual([1, 1.25, 1.5]);
    await call("sequence_layers", { layerIds: ids, start: 0, gap: -0.5 });
    expect(ids.map((id) => L().find((l) => l.id === id)!.inPoint)).toEqual([0, 1.5, 3]);
    const { compId } = await call("create_variant", { name: "Vertical", width: 1080, height: 1920 });
    const v = editor.project.compositions.find((c) => c.id === compId)!;
    expect(v.layers.length).toBe(3);
    expect(v.layers[0].id).not.toBe(L()[0].id);
    await call("batch", { commands: [{ type: "marker.add", t: 1, label: "beat" }, { type: "comp.update", duration: 8 }] });
    expect(editor.project.compositions[0].duration).toBe(8);
  });

  it("render tools return images; resources and export approval work", async () => {
    const r = (await client.callTool({ name: "render_frame", arguments: { time: 1 } })) as { content: { type: string }[] };
    expect(r.content[0].type).toBe("image");
    const sheet = (await client.callTool({ name: "render_contact_sheet", arguments: { count: 4 } })) as { content: { type: string }[] };
    expect(sheet.content[0].type).toBe("image");
    const res = await client.readResource({ uri: "mge://project" });
    expect(JSON.parse((res.contents[0] as { text: string }).text).project).toBe("MCP test");
    await expect(call("export_start", { format: "prores4444" })).rejects.toThrow(/declined/);
    port.exportApproved = true;
    expect((await call("export_start", { format: "prores4444" })).id).toBe("job_test");
  });
});
