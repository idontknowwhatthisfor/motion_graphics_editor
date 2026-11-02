import { execFileSync, spawn, type SpawnOptions } from "node:child_process";

/** Sum of RSS (bytes) of a process and all its descendants (macOS + Linux). */
export function treeRss(rootPid: number): number {
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
  } catch {
    return 0;
  }
  const rows = out.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const [pid, ppid, kb] of rows) {
    rss.set(pid, kb * 1024);
    (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid);
  }
  let total = 0;
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!;
    total += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return total;
}

/** Run a command, sampling peak memory of its process tree. */
export function runMeasured(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<{ code: number; ms: number; peakBytes: number; output: string }> {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, treeRss(child.pid!))), 500);
    child.on("close", (code) => {
      clearInterval(timer);
      res({ code: code ?? -1, ms: Date.now() - t0, peakBytes: peak, output });
    });
  });
}

/** Peak memory of THIS process tree while `fn` runs (for in-process exports). */
export async function measureSelf<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number; peakBytes: number }> {
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, treeRss(process.pid))), 500);
  const t0 = Date.now();
  try {
    const result = await fn();
    return { result, ms: Date.now() - t0, peakBytes: peak };
  } finally {
    clearInterval(timer);
  }
}

export const mb = (b: number) => `${Math.round(b / 1024 / 1024)} MB`;
