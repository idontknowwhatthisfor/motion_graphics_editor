/**
 * Preload for the Mac app: exposes a small, fixed API as window.mgeNative.
 * The page never gets Node or Electron objects (contextIsolation + sandbox).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type NativeFile = { path: string; name: string; data: ArrayBuffer };

const listen = <T,>(channel: string, cb: (v: T) => void) => {
  const fn = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => void ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld("mgeNative", {
  platform: process.platform,
  onMenu: (cb: (id: string) => void) => listen("mge:menu", cb),
  onOpenFiles: (cb: (files: NativeFile[]) => void) => listen("mge:open-files", cb),
  onOpenProject: (cb: (name: string) => void) => listen("mge:open-project", cb),
  pick: (kind: "import" | "project"): Promise<void> => ipcRenderer.invoke("mge:pick", kind),
  flushed: () => ipcRenderer.send("mge:flushed"),
  revealInFinder: (path: string): Promise<void> => ipcRenderer.invoke("mge:reveal", path),
  setTitle: (title: string, edited: boolean) => ipcRenderer.send("mge:title", title, edited),
  setMenuState: (state: { canUndo: boolean; canRedo: boolean; hasSelection: boolean }) => ipcRenderer.send("mge:menu-state", state),
});
