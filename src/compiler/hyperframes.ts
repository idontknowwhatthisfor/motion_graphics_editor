/**
 * Compiles a composition from the JSON project to a HyperFrames project
 * (index.html + assets/). The JSON stays the source of truth; this output is
 * disposable and regenerated on every export.
 *
 * HyperFrames contract (skills/hyperframes/SKILL.md, checked 2 Nov 2026):
 *  - root element with data-composition-id, data-start, data-duration,
 *    data-width, data-height; timed elements carry class="clip".
 *  - one paused GSAP timeline registered as window.__timelines[<id>].
 *  - everything visible is a pure function of timeline time.
 *
 * How the timeline drives our renderer: one linear tween of a proxy object's
 * `t` from 0 to duration. The proxy's setter evaluates the composition at t
 * and redraws the SVG, so seeking the timeline to any time draws that frame
 * deterministically (no onUpdate callbacks, which seek() can suppress).
 */
import type { Asset, Project } from "../core/types";

export interface CompileOptions {
  compId?: string;
  /** Contents of runtime.generated.js (window.MGE). */
  runtimeJs: string;
  /** Path of gsap.min.js relative to index.html. */
  gsapSrc?: string;
  /** Map an asset to the URL used inside the compiled HTML. */
  assetUrl?: (a: Asset) => string;
  /** Composition id used in the HTML (default "main"). */
  htmlCompositionId?: string;
}

export interface CompiledComposition {
  html: string;
  compositionId: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  /** Assets referenced by path that must be copied next to index.html. */
  assets: Asset[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/** JSON safe to embed in a <script> tag. */
const scriptJson = (x: unknown) =>
  JSON.stringify(x).replace(/</g, "\\u003c").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");

export function exportedAssetPath(a: Asset): string {
  if (a.src.startsWith("data:")) return a.src;
  const base = a.src.split("/").pop() ?? a.id;
  return `assets/${a.id}-${base}`.replace(/[^a-zA-Z0-9._/-]/g, "_");
}

export function compileToHyperFrames(project: Project, opts: CompileOptions): CompiledComposition {
  const comp = project.compositions.find((c) => c.id === (opts.compId ?? project.activeCompId)) ?? project.compositions[0];
  const id = opts.htmlCompositionId ?? "main";
  const assetUrl = opts.assetUrl ?? exportedAssetPath;

  // Only what this composition needs; reference video is never exported (ED-17).
  const usedAssetIds = new Set(comp.layers.filter((l) => l.type === "image").map((l) => (l as { assetId: string }).assetId));
  const assets = project.assets.filter((a) => usedAssetIds.has(a.id));
  const slim: Project = {
    ...project,
    compositions: [{ ...comp, layers: comp.layers.filter((l) => l.type !== "reference") }],
    assets: assets.map((a) => ({ ...a, src: assetUrl(a) })),
    activeCompId: comp.id,
  };

  const preload = assets
    .map((a) => `<img src="${esc(assetUrl(a))}" alt="" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none">`)
    .join("\n      ");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="generator" content="motion-graphics-editor" />
    <title>${esc(project.name)} – ${esc(comp.name)}</title>
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      #root { position: relative; width: ${comp.width}px; height: ${comp.height}px; overflow: hidden; }
      #stage { position: absolute; inset: 0; }
      #stage > svg { width: ${comp.width}px; height: ${comp.height}px; }
    </style>
    <script src="${esc(opts.gsapSrc ?? "assets/gsap.min.js")}"></script>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="${id}"
      data-start="0"
      data-duration="${comp.duration}"
      data-fps="${comp.fps}"
      data-width="${comp.width}"
      data-height="${comp.height}"
    >
      <div id="stage" class="clip" data-start="0" data-duration="${comp.duration}" data-track-index="1" data-layout-allow-overflow data-layout-allow-overlap></div>
      ${preload}
    </div>
    <script id="mge-project" type="application/json">${scriptJson(slim)}</script>
    <script>${opts.runtimeJs}</script>
    <script>
      (function () {
        var project = JSON.parse(document.getElementById("mge-project").textContent);
        var player = MGE.mount(project, ${JSON.stringify(comp.id)}, document.getElementById("stage"));
        var current = 0;
        var proxy = {};
        Object.defineProperty(proxy, "t", {
          get: function () { return current; },
          set: function (v) { current = v; player.seek(v); },
        });
        player.seek(0);
        window.__timelines = window.__timelines || {};
        var tl = gsap.timeline({ paused: true });
        tl.fromTo(proxy, { t: 0 }, { t: ${comp.duration}, duration: ${comp.duration}, ease: "none", immediateRender: true }, 0);
        window.__timelines[${JSON.stringify(id)}] = tl;
        // Direct hook for our own exporter and frame checks.
        window.__mgeSeek = function (t) { player.seek(t); };
      })();
    </script>
  </body>
</html>
`;
  return { html, compositionId: id, duration: comp.duration, fps: comp.fps, width: comp.width, height: comp.height, assets };
}
