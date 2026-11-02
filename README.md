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
  Cmd+Z / Cmd+Shift+Z undo/redo, Cmd+S saves a version, Cmd+K comp settings.
- Click a property's stopwatch to animate it; click a property name in the
  timeline to open its curve in the graph editor.
- Drag SVG/PNG/JPG onto the window to import. Drop a video to use it as a
  reference layer; it is never exported.
- Projects autosave to `projects/<name>/`, with versions every 2 minutes.
- Export › Resolve-ready preset writes ProRes 4444 with alpha to `renders/`.
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

Command line export: `npm run export -- projects/<name>/project.json --resolve`
(add `--engine hyperframes` to render with HyperFrames).

See `CLAUDE.md` for architecture and what comes next.
