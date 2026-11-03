/**
 * The Mac app (ED-26): one window around the same editor UI, with a Dock
 * icon, native menus and shortcuts, file dialogs, and files dropped on the
 * Dock icon. It runs its own 127.0.0.1 server with the same project store,
 * export jobs and Claude bridge as `npm run dev`, so the MCP server and every
 * script work unchanged.
 *
 *   npm run app        build the UI, then open the app (serves dist/)
 *   npm run app:dev    open the app on a live Vite dev server (hot reload)
 *   npm run app:install  put "Motion Graphics.app" in ~/Applications for the Dock
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { attachBridge } from "../scripts/bridge";
import { EXPORT_EXT, EXPORT_FORMATS, exportDirect, ROOT } from "../scripts/lib/node-export";
import { createStoreMiddleware } from "../scripts/vite-project-store";
import { parseProject } from "../src/core/project-io";

const DEV = process.env.MGE_DEV === "1";
const PROD_PORT = 5199; // fixed so the page keeps its localStorage (last project) between launches
const DEV_PORT = 5198;
const APP_NAME = "Motion Graphics";
const PROJECTS = join(ROOT, "projects");
const MEDIA_EXT = [".png", ".jpg", ".jpeg", ".svg", ".mp4", ".m4v", ".mov", ".webm", ".wav", ".mp3", ".m4a", ".aac", ".aif", ".aiff"];

app.setName(APP_NAME);

let win: BrowserWindow | null = null;
let baseUrl = "";
let closeServer: () => Promise<void> | void = () => undefined;
const pendingOpen: string[] = []; // files opened before the window was ready

// ---------- server ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function listen(server: Server, port: number): Promise<number> {
  return new Promise((res, rej) => {
    const onErr = (e: NodeJS.ErrnoException) => {
      server.off("listening", onOk);
      if (e.code === "EADDRINUSE" && port !== 0) listen(server, 0).then(res, rej);
      else rej(e);
    };
    const onOk = () => {
      server.off("error", onErr);
      res((server.address() as { port: number }).port);
    };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen(port, "127.0.0.1");
  });
}

async function startServer(): Promise<string> {
  if (DEV) {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({ root: ROOT, configFile: join(ROOT, "vite.config.ts"), server: { port: DEV_PORT, host: "127.0.0.1" }, clearScreen: false });
    await vite.listen();
    closeServer = () => vite.close();
    return (vite.resolvedUrls?.local[0] ?? `http://127.0.0.1:${DEV_PORT}/`).replace(/\/$/, "");
  }
  const dist = join(ROOT, "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error(`The editor UI is not built yet. In ${ROOT}, run: npm run build`);
  const server = createServer();
  const bridge = attachBridge(server, ROOT);
  const store = createStoreMiddleware({
    root: ROOT,
    bridgeToken: () => bridge.token,
    load: async () => ({ parseProject, exportDirect, EXPORT_FORMATS, EXPORT_EXT }),
  });
  server.on("request", (req, res) =>
    store(req, res, () => {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      let file = resolve(dist, "." + path);
      if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = join(dist, "index.html");
      res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
      createReadStream(file).pipe(res);
    }),
  );
  const port = await listen(server, PROD_PORT);
  closeServer = () => new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

// ---------- files ----------
type NativeFile = { path: string; name: string; data: ArrayBuffer };
const readNative = (p: string): NativeFile => {
  const b = readFileSync(p);
  return { path: p, name: basename(p), data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
};
const safeName = (s: string) => s.replace(/[^a-zA-Z0-9 _.-]/g, "_").replace(/^\.+/, "").slice(0, 80) || "untitled";

/**
 * Bring a project.json from anywhere into projects/<name>/ (with its assets
 * folder) and return the store name. Files already in projects/ open in place.
 */
function adoptProjectFile(file: string): string {
  parseProject(readFileSync(file, "utf8")); // refuse anything that is not a project
  const dir = dirname(resolve(file));
  const rel = relative(PROJECTS, dir);
  if (!rel.startsWith("..") && !rel.includes(sep) && rel && basename(file) === "project.json") return rel;
  const stem = basename(file) === "project.json" ? basename(dir) : basename(file, extname(file));
  let name = safeName(stem);
  for (let i = 2; existsSync(join(PROJECTS, name)); i++) name = `${safeName(stem)}-${i}`;
  mkdirSync(join(PROJECTS, name, "versions"), { recursive: true });
  copyFileSync(file, join(PROJECTS, name, "project.json"));
  if (existsSync(join(dir, "assets"))) cpSync(join(dir, "assets"), join(PROJECTS, name, "assets"), { recursive: true });
  return name;
}

function openPaths(paths: string[]) {
  if (!win || win.webContents.isLoading()) return void pendingOpen.push(...paths);
  const media: NativeFile[] = [];
  for (const p of paths) {
    try {
      if (extname(p).toLowerCase() === ".json") win.webContents.send("mge:open-project", adoptProjectFile(p));
      else if (MEDIA_EXT.includes(extname(p).toLowerCase())) media.push(readNative(p));
    } catch (e) {
      dialog.showErrorBox("Cannot open file", `${basename(p)}: ${(e as Error).message}`);
    }
  }
  if (media.length) win.webContents.send("mge:open-files", media);
  win.show();
}

// ---------- menus ----------
let menuState = { canUndo: false, canRedo: false, hasSelection: false };
const send = (id: string) => () => win?.webContents.send("mge:menu", id);

function buildMenu() {
  const item = (label: string, id: string, accelerator?: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({ label, id, accelerator, click: send(id), ...extra });
  const sel = { enabled: menuState.hasSelection };
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Show Project Folder in Finder", click: () => shell.openPath(ROOT) },
        { label: "Show Renders in Finder", click: () => (mkdirSync(join(ROOT, "renders"), { recursive: true }), shell.openPath(join(ROOT, "renders"))) },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        item("New Project…", "new-project", "CmdOrCtrl+Alt+N"),
        item("Projects…", "open-project", "CmdOrCtrl+O"),
        { label: "Open Project File…", accelerator: "CmdOrCtrl+Shift+O", click: () => pickProjectFile() },
        item("Open Sample", "sample"),
        item("New from Template…", "template"),
        item("Brand Kit…", "brand"),
        { type: "separator" },
        item("Save Version", "save-version", "CmdOrCtrl+S"),
        item("Version History…", "versions"),
        { type: "separator" },
        { label: "Import…", accelerator: "CmdOrCtrl+I", click: () => pickImport() },
        item("Export…", "export", "CmdOrCtrl+M"),
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        item("Undo", "undo", "CmdOrCtrl+Z", { enabled: menuState.canUndo }),
        item("Redo", "redo", "CmdOrCtrl+Shift+Z", { enabled: menuState.canRedo }),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        item("Duplicate", "duplicate", "CmdOrCtrl+D", sel),
        item("Split Layer at Playhead", "split", "CmdOrCtrl+Shift+D", sel),
        item("Delete", "delete", undefined, sel),
      ],
    },
    {
      label: "Composition",
      submenu: [
        item("New Composition…", "new-comp", "CmdOrCtrl+N"),
        item("Composition Settings…", "comp-settings", "CmdOrCtrl+K"),
        item("Precompose Selected Layers", "precompose", "CmdOrCtrl+Shift+C", sel),
        item("Template Fields…", "template"),
        { type: "separator" },
        item("Add Marker at Playhead", "marker"),
      ],
    },
    {
      label: "Layer",
      submenu: [
        item("New Shape", "add:shape"),
        item("New Text", "add:text", "CmdOrCtrl+Alt+Shift+T"),
        item("New Solid", "add:solid", "CmdOrCtrl+Y"),
        item("New Null", "add:null", "CmdOrCtrl+Alt+Shift+Y"),
      ],
    },
    {
      label: "View",
      submenu: [
        item("Play / Pause", "play"),
        item("Show Reference Video", "toggle-ref"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Read the Notes (README)", click: () => shell.openPath(join(ROOT, "README.md")) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function pickImport() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: "Import",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Images, video and audio", extensions: MEDIA_EXT.map((e) => e.slice(1)) },
      { name: "Project", extensions: ["json"] },
    ],
  });
  if (!r.canceled) openPaths(r.filePaths);
}

async function pickProjectFile() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, { title: "Open Project File", defaultPath: PROJECTS, properties: ["openFile"], filters: [{ name: "Project", extensions: ["json"] }] });
  if (!r.canceled && r.filePaths[0]) openPaths([r.filePaths[0]]);
}

// ---------- window ----------
const stateFile = () => join(app.getPath("userData"), "window.json");
function loadBounds(): { width: number; height: number; x?: number; y?: number } {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return { width: 1600, height: 1000 };
  }
}

async function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 1100,
    minHeight: 700,
    title: APP_NAME,
    backgroundColor: "#0b0d10",
    show: false,
    webPreferences: { preload: join(ROOT, "dist-electron", "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win?.show());
  const local = (u: string) => u === baseUrl || u.startsWith(baseUrl + "/");
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (local(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.on("did-finish-load", () => openPaths(pendingOpen.splice(0)));

  // Flush the autosave before the window closes.
  let flushed = false;
  win.on("close", (e) => {
    try {
      writeFileSync(stateFile(), JSON.stringify(win!.getBounds()));
    } catch {
      /* not fatal */
    }
    if (flushed || !win || win.webContents.isLoading()) return;
    e.preventDefault();
    const done = () => {
      flushed = true;
      win?.close();
    };
    ipcMain.once("mge:flushed", done);
    setTimeout(done, 2000);
    win.webContents.send("mge:menu", "flush-save");
  });
  win.on("closed", () => (win = null));
  await win.loadURL(baseUrl);
}

// ---------- IPC ----------
ipcMain.handle("mge:pick", (_e, kind: string) => (kind === "project" ? pickProjectFile() : pickImport()));
ipcMain.handle("mge:reveal", (_e, p: string) => {
  const full = resolve(ROOT, String(p));
  if (full.startsWith(ROOT + sep) && existsSync(full)) shell.showItemInFolder(full);
});
ipcMain.on("mge:title", (_e, title: string, edited: boolean) => {
  win?.setTitle(String(title));
  win?.setDocumentEdited(!!edited);
});
ipcMain.on("mge:menu-state", (_e, s: typeof menuState) => {
  if (s.canUndo === menuState.canUndo && s.canRedo === menuState.canRedo && s.hasSelection === menuState.hasSelection) return;
  menuState = { canUndo: !!s.canUndo, canRedo: !!s.canRedo, hasSelection: !!s.hasSelection };
  buildMenu();
});

// ---------- lifecycle ----------
app.on("open-file", (e, p) => {
  e.preventDefault();
  openPaths([p]);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_e, argv) => {
    openPaths(argv.slice(1).filter((a) => existsSync(a) && statSync(a).isFile()));
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(async () => {
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(join(ROOT, "electron/icon.png"));
    app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: "0.1.0", credits: `Projects and renders live in ${ROOT}` });
    buildMenu();
    try {
      baseUrl = await startServer();
    } catch (e) {
      dialog.showErrorBox("Motion Graphics could not start", (e as Error).message);
      app.exit(1);
      return;
    }
    await createWindow();
    app.on("activate", () => {
      if (!win) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  // Mac apps stay in the Dock with no window open; clicking the Dock icon opens a new one.
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => void closeServer());
