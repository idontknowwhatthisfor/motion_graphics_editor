import { describe, expect, it } from "vitest";
import { compileToHyperFrames } from "../src/compiler/hyperframes";
import { lowerThirdProject } from "../src/core/samples";
import { makeLayer } from "../src/core/factory";

describe("HyperFrames compiler", () => {
  it("emits the HyperFrames contract and leaves reference video out", () => {
    const p = structuredClone(lowerThirdProject()); // projects are frozen; clone to mutate
    const comp = p.compositions[0];
    p.assets.push({ id: "asset_ref", name: "ref.mp4", kind: "video", src: "assets/ref.mp4", width: 1920, height: 1080 });
    comp.layers.push({ ...makeLayer("reference", comp, { assetId: "asset_ref" }), id: "layer_ref" } as never);
    const out = compileToHyperFrames(p, { runtimeJs: "/*rt*/" });
    expect(out.html).toContain('data-composition-id="main"');
    expect(out.html).toContain(`data-duration="${comp.duration}"`);
    expect(out.html).toContain('class="clip"');
    expect(out.html).toContain('window.__timelines["main"] = tl');
    expect(out.html).not.toContain("layer_ref");
    expect(out.html).not.toContain("ref.mp4");
    expect(out.assets).toEqual([]);
  });
  it("escapes </script> inside project text", () => {
    const p = lowerThirdProject("</script><script>alert(1)</script>");
    const out = compileToHyperFrames(p, { runtimeJs: "" });
    expect(out.html).not.toContain("</script><script>alert(1)");
  });
});
