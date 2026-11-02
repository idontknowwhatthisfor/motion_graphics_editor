# Motion Graphics Editor

A personal keyframe motion graphics editor whose projects are plain JSON, built
so Claude can later edit the same project through a local MCP server. First job:
transparent overlays (ProRes 4444 with alpha) for DaVinci Resolve.

## Run it on the Mac

Needs Node 22+, FFmpeg (`brew install node ffmpeg`) and Google Chrome in
/Applications. Chrome (headless) does every render: preview checks, exports,
tests and HyperFrames. No Chromium download is needed; to use a different
Chrome binary set `MGE_CHROME`.

```
cd ~/Desktop/motion_graphics
npm install
npm run build:runtime
npm run dev                       # open http://127.0.0.1:5173
```

### The Mac app (Dock icon, menus, file dialogs)

```
npm run app:install     # builds, then puts "Motion Graphics.app" in ~/Applications
```

Open it from Spotlight, then right-click its Dock icon › Options › Keep in
Dock. The app loads the editor from this folder, so projects stay in
`projects/` and renders in `renders/`. After pulling new code run
`npm run build && npm run build:electron`; re-run `app:install` only when
`npm install` changes the Electron version. `npm run app` opens it without
installing, and `npm run app:dev` opens it with hot reload.

In the app: File › Open Project File… (or dropping a `project.json` on the
Dock icon) copies a project from anywhere into `projects/` with its assets;
File › Import… (Cmd+I) or dropping images and video on the window or the
Dock icon imports them; File › Export… is Cmd+M. Claude connects to the app
the same way as to `npm run dev`; only run one of them at a time.

## Engine test (do this first, PRD step 1)

With the Claude app open:

```
npm run engine-test
```

It renders a 15 s, 1080p, 30-layer transparent overlay with HyperFrames and
with the built-in exporter, records time and peak memory, checks both files
with ffprobe, and confirms a keyframe edit changes the frame. Results:
`renders/engine-test/REPORT.md`. Then import the two `.mov` files into
DaVinci Resolve over a coloured clip and check the edges.

## Everyday use

- Tools: V select/move, P pen, R rectangle, E ellipse, T text. Space plays,
  arrows step frames, M adds a marker, Cmd+Shift+D splits, Cmd+D duplicates,
  Cmd+Z / Cmd+Shift+Z undo/redo, Cmd+S saves a version, Cmd+K comp settings,
  Cmd+Shift+C precomposes the selected layers into a nested comp.
- Inspector › Effects adds blur, glow, drop shadow, colour correction and a
  gradient overlay; every effect value has a stopwatch. + Layer › Nested comp
  places another composition as a layer.
- The "=" next to a property's stopwatch adds an expression, e.g.
  `wiggle(2, 30)`, `loopOut("pingpong")` or
  `prop("Title", "transform.position") + [0, 80]`. Shape layers also have
  a Repeater (rows, rings, spirals) and an Offset path.
- Brand (toolbar) holds the project's brand colours and fonts; they appear as
  swatches and font buttons in the Inspector, and Shift-clicking a swatch
  links the colour so editing the kit recolours everything. Kits can be saved
  to `library/brand-kits/` for other projects.
- Template (toolbar) names the fields to change when reusing a comp (text,
  colours, numbers, positions), fills them in one place, saves the project to
  `library/templates/`, and starts new projects from saved templates.
- Click a property's stopwatch to animate it; click a property name in the
  timeline to open its curve in the graph editor.
- Drag SVG/PNG/JPG, video (MP4/MOV) or audio (WAV/MP3) onto the window to
  import. A video layer starts as a reference (not exported); switch its
  Role to Export in the Inspector to render it into the file. Audio layers
  show a waveform, play with Space, and Detect beats adds beat markers you
  can snap keyframes to. Exports with audio layers include the mixed sound.
- Projects autosave to `projects/<name>/`, with versions every 2 minutes.
- Export › Resolve-ready preset writes ProRes 4444 with alpha to `renders/`.
  The dialog also offers WebM with alpha, GIF, MP4 and a PNG sequence.
  In Resolve, set Clip Attributes › Alpha Mode to Straight if edges look dark.

## Let Claude edit the project

```
npm run mcp:setup     # once: registers the server with Claude Code and the Claude app
npm run dev           # keep the editor open while Claude works
```

Then ask, for example, "Using motion-graphics, build a lower third with my
name and ease it in over 12 frames". Claude's edits appear live and wait in
the Claude panel: hold "before" to compare, then Keep or Reject. Stop blocks
Claude until you press Resume, and exports Claude asks for need your approval.
Restart the Claude app after setup.

Setup also installs a skill that teaches Claude the project format and
motion conventions (for the Claude desktop app, upload
`renders/motion-graphics-editor-skill.zip` in Settings › Capabilities ›
Skills). Ready-made prompts appear in Claude's prompt menu: **Make
variants**, **Retime to audio** and **Critique motion**. When Claude needs
a choice from you, such as which brand font or the values for a template,
it asks with a small form. Long exports report progress, and stopping
Claude's request cancels the export.

Command line export: `npm run export -- projects/<name>/project.json --resolve`
(add `--engine hyperframes` to render with HyperFrames).

See `CLAUDE.md` for architecture and what comes next.
