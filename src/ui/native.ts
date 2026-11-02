/**
 * The bridge to the Electron Mac app (ED-26). In a plain browser window
 * `native` is undefined and every caller falls back to web behaviour.
 * The preload script (electron/preload.ts) defines window.mgeNative.
 */
export interface NativeFile {
  path: string;
  name: string;
  data: ArrayBuffer;
}
export interface NativeApi {
  platform: string;
  /** Subscribe to native menu commands; returns an unsubscribe function. */
  onMenu(cb: (id: string) => void): () => void;
  /** Files dropped on the Dock icon or opened with Finder's "Open With". */
  onOpenFiles(cb: (files: NativeFile[]) => void): () => void;
  /** A project.json opened from Finder or the File menu, already copied into projects/<name>. */
  onOpenProject(cb: (name: string) => void): () => void;
  /** Show the native Import or Open Project File dialog; results arrive through the listeners above. */
  pick(kind: "import" | "project"): Promise<void>;
  /** Reply to the "flush-save" menu command once the autosave is written. */
  flushed(): void;
  revealInFinder(path: string): Promise<void>;
  setTitle(title: string, edited: boolean): void;
  /** Tell the main process which menu items make sense right now. */
  setMenuState(state: { canUndo: boolean; canRedo: boolean; hasSelection: boolean }): void;
}

export const native: NativeApi | undefined = (globalThis as { mgeNative?: NativeApi }).mgeNative;

export const toFile = (f: NativeFile) => new File([f.data], f.name, { type: guessType(f.name) });

function guessType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", json: "application/json" } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}
