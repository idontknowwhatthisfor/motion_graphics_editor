# Motion Graphics Editor — notes for Claude Code

Personal motion graphics editor for kp's Mac (M1 Air, 8 GB). The PRD is
`PRD Motion Graphics Editor with Claude Integration.md` in this folder; read
it before changing scope. kp does not read the code, so every change must be
proven with the checks below.

## Architecture (one rule: everything goes through the Command API)

```
UI (React, src/ui) ──┐
MCP server (mcp/) ───┼─> Command API (src/core/commands.ts) ─> Editor (src/core/editor.ts)
scripts/tests ───────┘        plain-JSON commands                undo/redo, change sets, audit log
                                                                   │
                     JSON project (src/core/types.ts) <────────────┘
                                   │
            evaluateComposition (src/core/evaluate.ts)  -> ResolvedScene (plain values, world matrices)
                                   │
            SvgRenderer (src/render/renderer.ts)  <- the ONLY renderer: editor preview,
                                   │                   frame checks and export all use it
            compileToHyperFrames (src/compiler/hyperframes.ts) -> index.html + GSAP timeline
                                   │
            export: HyperFrames CLI (pinned 0.9.4) or direct Playwright+FFmpeg (scripts/lib/node-export.ts)
```

- **Project format** (`src/core/types.ts`): versioned JSON. Times are in
  SECONDS, never frames (so fps changes never move keyframes). `layers[0]` is
  the top layer. Animatable values are `Prop { value, keyframes? }`; easing on
  a keyframe applies to the segment after it, and is always linear, hold or a
  cubic-bezier (so the graph editor can edit it).
- **Property paths** (`src/core/props.ts`): `transform.position`,
  `fill.paint.color`, `geometry.<id|index>.size`, `animators.<id>.selector.start`,
  `masks.<id>.path`, `style.size`, `trim.end`… Used by the UI, commands and MCP.
- **Commands** (`src/core/commands.ts`): pure reducers on an Immer draft. A
  dispatch of several commands is atomic. Add new edit types here, never by
  mutating the project elsewhere.
- **Undo and change sets** (`src/core/editor.ts`, `src/core/revert.ts`): each
  step stores immutable before/after snapshots; undo and reject use an
  id-based `transfer()` so edits do not have to be undone in LIFO order
  (Claude's change set can stay pending while kp keeps editing). Do NOT switch
  to Immer index patches: test "undoing my earlier edit while Claude's layers
  sit above it" covers why.
- **Claude's edits**: dispatch with `{ source: "claude" }`. They land in an
  open change set (auto-created), then `finishChangeSet` → pending review →
  `keepChangeSet` (one undo step) or `rejectChangeSet`. Read-only mode blocks
  Claude; Claude can never change the permission mode.
- **Renderer**: SVG + a tiny keyed vdom (`src/render/vdom.ts`). Text with
  animators is laid out per character with canvas `measureText`. Track mattes
  and masks are SVG masks. Trim paths use `pathLength=100` dashes (stroke only).
  Boolean ops (subtract/intersect) apply to the fill.
- **Compiler**: one `.clip` stage element; a GSAP tween of a proxy object's
  `t` whose setter redraws the frame (deterministic seek, no onUpdate). The
  runtime is `src/compiler/runtime.generated.js` (built by
  `npm run build:runtime`, gitignored).
- **Local server** (`scripts/vite-project-store.ts`, Vite middleware, 127.0.0.1
  only): projects in `projects/<name>/project.json` (atomic writes), versions
  every 2 min in `versions/`, imported media in `assets/`, export jobs with
  progress and cancel.

## Claude connection (MCP)

```
Claude Code / Claude app ──stdio──> mcp/server.ts ──ws agent──> bridge (scripts/bridge.ts, in the Vite dev server)
                                                                 ──ws editor──> browser tab (src/ui/bridge-client.ts)
                                                                                   └─> Editor.dispatch(source "claude")
```

- `mcp/tools.ts`: the 25 tools (inspect, look, change sets, build, arrange,
  batch, deliver) + 4 resources + server instructions. Tools only use an
  `EditorPort` (`mcp/port.ts`): `LocalPort` in tests, `BridgePort` for real.
- The bridge token is regenerated on every `npm run dev` and written to
  `.cache/bridge.json` (mode 600). The editor gets it same-origin from
  `/api/bridge-info`; `/api` and `/projects` refuse non-localhost Host headers.
- `render_frame` / `render_contact_sheet` (`mcp/frames.ts`) compile the
  project and screenshot it in a warm headless Chrome that closes after 2
  idle minutes (memory on the 8 GB Mac).
- Exports from Claude wait for an approval dialog in the editor. Stop in the
  Claude panel finishes the open change set and refuses Claude edits until
  Resume. Claude can never change the permission mode or add assets.
- Protocol: SDK 1.32.1, protocol 2025-11-25 (newest the SDK supports). The
  PRD names 2026-07-28; upgrade the SDK when Claude apps require it. All
  protocol code is in `mcp/server.ts` + the SDK.
- `npm run mcp:setup` registers the server with Claude Code (user scope) and
  the Claude desktop app config (backs it up first).

## Checks to run before every commit

```
npm run build:runtime   # after touching src/core, src/render or src/compiler
npm run typecheck
npm test                # Vitest: easing, interpolation, commands, undo, change sets, compiler
npm run e2e             # Playwright drives the real editor; screenshots in renders/e2e/
npm run e2e:mcp         # real stdio MCP server + bridge + editor: edits, review, stop, approved export
npm run e2e:app         # the Electron app: menus, Finder opens, project adoption, export, save on close
                        # (Linux container: NODE_OPTIONS= xvfb-run -a npx tsx scripts/e2e-electron.ts)
npm run engine-test     # slow (~3 min): ProRes 4444 alpha renders + ffprobe + keyframe edit check
```

Browser: always Google Chrome via `chromePath()` in
`scripts/lib/node-export.ts` (Playwright gets it as executablePath, HyperFrames
via HYPERFRAMES_BROWSER_PATH). kp chose Chrome over Chromium; do not add
Chromium downloads. The cloud container has no Chrome and falls back to
/opt/pw-browsers/chromium there only.

## Status (Milestone 1, browser window)

Done: JSON format, Command API, unlimited undo, change sets with id-based
reject, audit log, evaluator (parenting, bezier easing, motion paths), SVG
renderer (shape/text/image/solid/null, blend modes, masks, track mattes,
gradients, trim paths, boolean ops, per-character text animators), HyperFrames
compiler, engine test, direct exporter (ProRes 4444 alpha, MP4, PNG), editor
UI (viewer with move/pen/rect/ellipse/text tools and motion-path handles,
timeline with scrub/trim/split/snapping/markers/keyframe drag, graph editor,
inspector, comp settings with resize modes, import SVG/PNG/JPG + reference
video, autosave + version history, export dialog with Resolve preset).

Also done: local MCP server, bridge, setup command, connection status,
current action, Stop, change-set review, export approval (CL-01..CL-08).

## Status (Milestone 2, P1; kp asked for it before Gate 1)

Batch 1 done: effects stack (ED-11: blur, glow, drop shadow, colour
correction, gradient overlay; `layer.effects`, commands effect.add/update/
remove, paths `effects.<id>.<param>`, rendered as one SVG filter per layer in
renderer.ts `effectFilter`), nested comps (ED-02: `precomp` layer with compId
+ timeOffset, `comp.precompose`, loop checks via `compContains`, child ids are
prefixed `<layerId>__`, compiler ships every nested comp), WebM VP9 alpha and
GIF export (ED-20). Tests in tests/m2.test.ts.

Batch 2 done: Electron Mac app (ED-26). electron/main.ts runs its own
127.0.0.1:5199 server with the same store middleware (createStoreMiddleware in
scripts/vite-project-store.ts) and Claude bridge, serves dist/, and owns the
native menus (ids map to menuCommand() in src/ui/App.tsx), Import/Open
dialogs, Finder/Dock file opens (project.json is copied into projects/ by
adoptProjectFile) and a save-before-close handshake. The page only sees
window.mgeNative from electron/preload.ts (src/ui/native.ts). Entry is
electron/start.mjs (sets MGE_ROOT, Homebrew PATH). `npm run app:install`
(scripts/mac-app.ts) makes ~/Applications/Motion Graphics.app: a renamed,
ad-hoc signed copy of Electron.app whose Resources/app stub imports
electron/start.mjs from this folder. Electron is pinned to 44.10.1.

Batch 3 done: expressions (ED-12) as a safe formula language in
src/core/expressions.ts (not JS; Prop.expression; applied through the hook in
interpolate.ts that evaluateComposition installs; broken expressions fall back
to the plain value and checkExpression reports the error), repeaters and
offset paths (ED-09: ShapeLayer.repeater / offsetPath, shape.addOperator,
geometry.ts repeatMatrix / offsetPathD). Tests in tests/m2b.test.ts. MCP has
30 tools; keep it at 30 or fewer (tests/mcp.test.ts).

Batch 4 done: brand kits (ED-15: Project.brand, brand.set, expression
brand("Name"), swatches in colour rows, saved kits in library/brand-kits/)
and templates (ED-16: Composition.template.fields, template.addField/fill,
TemplateDialog, library/templates/<name>/ with assets, "New from template").
library/ is gitignored like projects/. MCP: fill_template; export_cancel was
folded into export_status {cancel} to stay at 30 tools.

Batch 5 done: audio layers (ED-14: AudioLayer with volume Prop and
mediaOffset, waveform on the timeline bar, Detect beats writes "beat"
markers via core/beats.ts, playback through WebAudio) and video layers in
export (ED-23: VideoLayer with role reference|export; export extracts stills
with FFmpeg into .cache/stills/ and the compiler points at them; audio is
mixed and muxed in a second FFmpeg pass: pcm_s24le MOV, aac MP4, opus WebM).

Batch 6 done: Claude extras. CL-09: export_start/export_status take
`wait: true`, which polls the job and sends notifications/progress;
aborting the tool call cancels the export (exporter now survives a cancel:
the killed FFmpeg no longer leaves an unhandled rejection). Export
status/cancel go through EditorPort (LocalPort fakes a job for tests).
CL-10: MCP elicitation via `ask()` in mcp/tools.ts; fill_template with no
values asks for every field, add_layer text with several brand fonts asks
which font; without client support the tool tells Claude what to ask.
CL-11: mcp/prompts.ts registers make_variants, retime_to_audio,
critique_motion (prompts don't count toward the 30-tool cap). CL-12:
skill/motion-graphics-editor/SKILL.md (format, units, paths, motion
conventions); `npm run mcp:setup` installs it in ~/.claude/skills and zips
it for the desktop app; also served as resource mge://skill.

Fusion export (kp asked; not in the PRD): format `fusion` writes
renders/<name>-<comp>-<time>-fusion/ with <comp>.comp (Resolve Fusion page:
File › Import › Fusion Composition), <comp>.setting (paste into a node view),
README and media. src/compiler/fusion.ts is pure: shapes/solids ->
Background + Rectangle/Ellipse/PolylineMask, text -> Text+, PNG/JPG ->
Loader, one Transform per layer and ancestor (Pivot = anchor, drawn at a rest
position; math in the file header), Merge Blend/ApplyMode; easing -> spline
handles, holds -> extra key, expressions/curved paths baked per frame.
Anything else is flattened to a PNG sequence (node-export.ts exportFusion)
and listed in the job's `notes` (shown in the dialog). tests/fusion.test.ts
models Fusion's nodes against the evaluator and parses the files with
Resolve's fuscript when installed. kp confirmed on 5 Nov 2026 that the
lower-third .comp looks right in Resolve's Fusion page (sizes in image-width
units, pivots, text placement, PNG alpha).

Milestone 2 (P1) is complete. Then, in PRD order:
1. Resolve-ready export polish and Gate 1 (kp finishes a 15 s overlay by hand).
2. Mask path and gradient handles in the viewer; local font list.
3. Frame cache for half-res playback if live SVG playback is too slow on the
   M1 with 30 layers (measure first).


## Conventions

- Keep the project format backward compatible; bump `PROJECT_FORMAT_VERSION`
  and migrate in `src/core/project-io.ts` when it must change.
- Pin engine versions (HyperFrames is 0.9.4 in `scripts/engine-test.ts` and
  `scripts/export.ts`).
- Small commits, each passing the checks above.
