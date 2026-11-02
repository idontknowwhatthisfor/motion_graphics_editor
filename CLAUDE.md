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
npm run engine-test     # slow (~3 min): ProRes 4444 alpha renders + ffprobe + keyframe edit check
```

In the cloud container use `MGE_CHROMIUM=/opt/pw-browsers/chromium` (auto-
detected). On the Mac run `npx playwright install chromium` once.

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

Next, in PRD order:
1. Resolve-ready export polish and Gate 1 (kp finishes a 15 s overlay by hand).
2. Mask path and gradient handles in the viewer; local font list.
3. P1 Claude items: MCP elicitation for missing input (CL-10), prompts such
   as Make variants / Retime to audio (CL-11), a bundled skill (CL-12),
   export progress notifications (CL-09).
4. Frame cache for half-res playback if live SVG playback is too slow on the
   M1 with 30 layers (measure first).


## Conventions

- Keep the project format backward compatible; bump `PROJECT_FORMAT_VERSION`
  and migrate in `src/core/project-io.ts` when it must change.
- Pin engine versions (HyperFrames is 0.9.4 in `scripts/engine-test.ts` and
  `scripts/export.ts`).
- Small commits, each passing the checks above.
