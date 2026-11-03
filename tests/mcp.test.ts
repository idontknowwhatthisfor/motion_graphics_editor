import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/core/editor";
import { makeProject } from "../src/core/factory";
import { evaluateComposition } from "../src/core/evaluate";
import { LocalPort } from "../mcp/port";
import { registerResources, registerTools, SERVER_INSTRUCTIONS } from "../mcp/tools";
import { registerPrompts, SKILL_PATH } from "../mcp/prompts";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";

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

  it("get_project names the project by its folder, not the name stored in the file", async () => {
    port.projectName = "q3-dashboard"; // the file itself still says "MCP test"
    expect((await call("get_project")).project).toBe("q3-dashboard");
  });

  it("says no project is open on the Projects screen, and refuses edits there", async () => {
    port.projectOpen = false;
    const p = await call("get_project");
    expect(p.projectOpen).toBe(false);
    expect(p.message).toMatch(/No project is open/);
    expect(p.compositions).toBeUndefined(); // not the unsaved sample the editor holds
    await expect(call("add_layer", { type: "shape" })).rejects.toThrow(/No project is open/);
    await expect(call("begin_change_set", { name: "x" })).rejects.toThrow(/No project is open/);
    expect(editor.project.compositions[0].layers.length).toBe(0);
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
    expect(JSON.parse((res.contents[0] as { text: string }).text).project).toBe(port.projectName); // the folder name, as in get_project
    await expect(call("export_start", { format: "prores4444" })).rejects.toThrow(/declined/);
    port.exportApproved = true;
    expect((await call("export_start", { format: "prores4444" })).id).toBe("job_test");
  });
});

describe("Claude extras (CL-09..CL-12)", () => {
  /** A client that answers elicitation forms with `answer`. */
  async function connectAsking(answer: (msg: string, schema: { properties: Record<string, unknown> }) => Record<string, unknown> | null) {
    const server = new McpServer({ name: "t", version: "0" }, { instructions: SERVER_INSTRUCTIONS });
    registerTools(server, port, async (_p, _d, _c, times) => times.map(() => fakePng), async () => fakePng);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "asker", version: "0" }, { capabilities: { elicitation: {} } });
    const asked: string[] = [];
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      const p = req.params as { message: string; requestedSchema: { properties: Record<string, unknown> } };
      asked.push(p.message);
      const content = answer(p.message, p.requestedSchema);
      return content ? { action: "accept", content: content as Record<string, string> } : { action: "decline" };
    });
    await c.connect(b);
    return { c, asked };
  }
  const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

  it("export_start with wait reports progress and finishes (CL-09)", async () => {
    port.exportApproved = true;
    const progress: number[] = [];
    const r = await client.callTool({ name: "export_start", arguments: { wait: true } }, undefined, { onprogress: (p) => progress.push(p.progress) });
    expect(JSON.parse(textOf(r)).status).toBe("done");
    expect(progress).toEqual([1, 2, 3, 4]);
  });

  it("cancelling a waiting export call cancels the export (CL-09)", async () => {
    port.exportApproved = true;
    const ctl = new AbortController();
    const p = client.callTool({ name: "export_status", arguments: { id: "job_test", wait: true } }, undefined, { signal: ctl.signal, onprogress: () => ctl.abort() });
    await expect(p).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 700));
    expect(port.fakeJob.status).toBe("cancelled");
    expect((await call("export_status", { id: "job_test" })).status).toBe("cancelled");
  });

  it("asks the user for template values and brand font choice (CL-10)", async () => {
    const tid = (await call("add_layer", { type: "text", text: "Your name" })).layerId;
    await call("batch", { commands: [{ type: "template.addField", layerId: tid, path: "text", name: "Name" }] });
    // Without elicitation support Claude is told what to ask.
    await expect(call("fill_template")).rejects.toThrow(/Ask the user for: Name \(text\)/);

    const { c, asked } = await connectAsking((msg, schema) => {
      if (msg.startsWith("Fill in")) return Object.fromEntries(Object.keys(schema.properties).map((k) => [k, "Ada Lovelace"]));
      if (msg.startsWith("Which brand font")) return { font: (schema.properties.font as { enum: string[] }).enum[1] };
      return null;
    });
    await c.callTool({ name: "fill_template", arguments: {} });
    const t = editor.project.compositions[0].layers.find((l) => l.id === tid)!;
    expect(t.type === "text" && t.text).toBe("Ada Lovelace");

    await call("batch", { commands: [{ type: "brand.set", brand: { name: "Kit", colors: [], fonts: [{ name: "Heading", family: "Inter", weight: 800 }, { name: "Body", family: "Georgia", weight: 400 }] } }] });
    const r = await c.callTool({ name: "add_layer", arguments: { type: "text", text: "Hello" } });
    const l = editor.project.compositions[0].layers.find((x) => x.id === JSON.parse(textOf(r)).layerId)!;
    expect(l.type === "text" && l.style.family).toBe("Georgia");
    expect(asked).toHaveLength(2);

    const decliner = await connectAsking(() => null);
    const d = (await decliner.c.callTool({ name: "add_layer", arguments: { type: "text", text: "x" } })) as { isError?: boolean };
    expect(d.isError).toBe(true);
  });

  it("ships prompts and the bundled skill (CL-11, CL-12)", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerPrompts(server);
    registerResources(server, port);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "p", version: "0" });
    await c.connect(b);
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["critique_motion", "make_variants", "retime_to_audio"]);
    const mv = await c.getPrompt({ name: "make_variants", arguments: { sizes: "1080x1350" } });
    expect((mv.messages[0].content as { text: string }).text).toContain("1080x1350");
    const cr = await c.getPrompt({ name: "critique_motion", arguments: {} });
    expect((cr.messages[0].content as { text: string }).text).toContain("easeOutCubic");
    const skill = await c.readResource({ uri: "mge://skill" });
    expect((skill.contents[0] as { text: string }).text).toMatch(/## Motion conventions/);
    expect(readFileSync(SKILL_PATH, "utf8")).toMatch(/^---\nname: motion-graphics-editor\ndescription: /);
  });
});
