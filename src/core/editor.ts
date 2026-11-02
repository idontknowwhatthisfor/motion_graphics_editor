/**
 * Editor: owns the project, runs commands, and keeps
 *  - unlimited undo/redo within a session (ED-22),
 *  - Claude's change sets, which can be previewed, kept or rejected (CL-06),
 *  - an audit log of every command (Permission and privacy: audit trail).
 *
 * Framework-free: used by the React UI, the local server and tests.
 */
import { produce, setAutoFreeze } from "immer";
import { applyCommand, CommandError, describeCommand, type Command } from "./commands";
import { newId } from "./id";
import { transfer } from "./revert";
import type { Project } from "./types";

setAutoFreeze(true);

/** One applied edit: immutable snapshots before and after (structurally shared). */
export interface Step {
  before: Project;
  after: Project;
}

export type Source = "user" | "claude" | "system";

export interface HistoryEntry {
  id: string;
  label: string;
  source: Source;
  /** Applied in order; undo reverts them in reverse (see revert.ts). */
  steps: Step[];
  commands: Command[];
  /** Consecutive dispatches with the same key merge into one undo step (drags). */
  coalesceKey?: string;
  time: number;
}

export type ChangeSetStatus = "open" | "pending" | "kept" | "rejected";
export interface ChangeSet {
  id: string;
  name: string;
  status: ChangeSetStatus;
  entries: HistoryEntry[];
  createdAt: number;
  /** Layer ids touched, for the "changed layers" list in review. */
  layerIds: string[];
}

export interface AuditEntry {
  time: number;
  source: Source;
  commands: Command[];
  ok: boolean;
  error?: string;
  changeSetId?: string;
}

export interface DispatchOptions {
  source?: Source;
  label?: string;
  coalesceKey?: string;
  /** Claude: put the edit into this change set (opened automatically if omitted). */
  changeSetId?: string;
}

export interface DispatchResult {
  ok: boolean;
  results: unknown[];
  error?: string;
  changeSetId?: string;
}

type Listener = (e: Editor) => void;

/** Ids of layers that differ between two snapshots (by reference). */
export function changedLayerIds(before: Project, after: Project): string[] {
  const ids = new Set<string>();
  for (const ca of after.compositions) {
    const cb = before.compositions.find((c) => c.id === ca.id);
    if (cb === ca) continue;
    const bm = new Map((cb?.layers ?? []).map((l) => [l.id, l]));
    for (const l of ca.layers) if (bm.get(l.id) !== l) ids.add(l.id);
    for (const l of cb?.layers ?? []) if (!ca.layers.some((x) => x.id === l.id)) ids.add(l.id);
  }
  return [...ids];
}

const forward = (cur: Project, steps: Step[], conflicts?: Set<string>) =>
  steps.reduce((p, s) => transfer(p, s.before, s.after, conflicts), cur);
const backward = (cur: Project, steps: Step[], conflicts?: Set<string>) =>
  [...steps].reverse().reduce((p, s) => transfer(p, s.after, s.before, conflicts), cur);

export class Editor {
  project: Project;
  past: HistoryEntry[] = [];
  future: HistoryEntry[] = [];
  changeSets: ChangeSet[] = [];
  audit: AuditEntry[] = [];
  /** Bumped on every change; cheap equality for UIs and autosave. */
  revision = 0;
  private listeners = new Set<Listener>();
  private maxAudit = 2000;

  constructor(project: Project) {
    this.project = project;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.revision++;
    for (const l of this.listeners) l(this);
  }

  /** Replace the project (load). Clears history. */
  load(project: Project) {
    this.project = project;
    this.past = [];
    this.future = [];
    this.changeSets = [];
    this.emit();
  }

  /** Run one or more commands as ONE atomic, undoable step. */
  dispatch(cmds: Command | Command[], opts: DispatchOptions = {}): DispatchResult {
    const list = Array.isArray(cmds) ? cmds : [cmds];
    const source = opts.source ?? "user";
    const results: unknown[] = [];
    const blocked =
      source === "claude" &&
      (this.project.settings.permissionMode === "readOnly"
        ? "Project is in Read only mode for Claude"
        : list.some((c) => c.type === "project.setPermissionMode")
          ? "Only the user can change the permission mode"
          : null);
    if (blocked) {
      const error = blocked;
      this.log({ time: Date.now(), source, commands: list, ok: false, error });
      return { ok: false, results, error };
    }
    let next: Project;
    try {
      next = produce(this.project, (draft) => {
        for (const c of list) results.push(applyCommand(draft as Project, c));
      });
    } catch (e) {
      const error = e instanceof CommandError ? e.message : `Internal error: ${(e as Error).message}`;
      this.log({ time: Date.now(), source, commands: list, ok: false, error });
      return { ok: false, results: [], error };
    }
    if (next === this.project) {
      this.log({ time: Date.now(), source, commands: list, ok: true });
      return { ok: true, results };
    }
    const step: Step = { before: this.project, after: next };
    this.project = next;
    const entry: HistoryEntry = {
      id: newId("h"),
      label: opts.label ?? (list.length === 1 ? describeCommand(list[0]) : `${list.length} edits`),
      source,
      steps: [step],
      commands: list,
      coalesceKey: opts.coalesceKey,
      time: Date.now(),
    };

    let changeSetId: string | undefined;
    if (source === "claude") {
      const cs = this.ensureChangeSet(opts.changeSetId, entry.label);
      cs.entries.push(entry);
      for (const id of changedLayerIds(step.before, step.after)) if (!cs.layerIds.includes(id)) cs.layerIds.push(id);
      changeSetId = cs.id;
    } else {
      const top = this.past[this.past.length - 1];
      if (opts.coalesceKey && top && top.coalesceKey === opts.coalesceKey) {
        const last = top.steps[top.steps.length - 1];
        // Merge into the previous step when nothing else happened in between.
        if (last.after === step.before) top.steps[top.steps.length - 1] = { before: last.before, after: step.after };
        else top.steps.push(step);
        top.commands.push(...list);
        top.time = entry.time;
      } else this.past.push(entry);
      this.future = [];
    }
    this.log({ time: entry.time, source, commands: list, ok: true, changeSetId });
    this.emit();
    return { ok: true, results, changeSetId };
  }

  private log(a: AuditEntry) {
    this.audit.push(a);
    if (this.audit.length > this.maxAudit) this.audit.splice(0, this.audit.length - this.maxAudit);
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  undo(): boolean {
    const e = this.past.pop();
    if (!e) return false;
    this.project = backward(this.project, e.steps);
    this.future.push(e);
    this.emit();
    return true;
  }
  redo(): boolean {
    const e = this.future.pop();
    if (!e) return false;
    this.project = forward(this.project, e.steps);
    this.past.push(e);
    this.emit();
    return true;
  }

  // ---------- change sets ----------
  get openChangeSet(): ChangeSet | undefined {
    return this.changeSets.find((c) => c.status === "open");
  }
  get pendingChangeSets(): ChangeSet[] {
    return this.changeSets.filter((c) => c.status === "open" || c.status === "pending");
  }

  beginChangeSet(name: string): ChangeSet {
    const open = this.openChangeSet;
    if (open) this.finishChangeSet(open.id);
    const cs: ChangeSet = { id: newId("cs"), name, status: "open", entries: [], createdAt: Date.now(), layerIds: [] };
    this.changeSets.push(cs);
    this.emit();
    return cs;
  }

  private ensureChangeSet(id: string | undefined, fallbackName: string): ChangeSet {
    if (id) {
      const cs = this.changeSets.find((c) => c.id === id);
      if (!cs) throw new CommandError(`Change set not found: ${id}`);
      if (cs.status !== "open") throw new CommandError(`Change set is ${cs.status}`);
      return cs;
    }
    return this.openChangeSet ?? this.beginChangeSet(`Claude: ${fallbackName}`);
  }

  /** Claude is done with a change set: it moves to review (or is kept in Auto-keep mode). */
  finishChangeSet(id: string): ChangeSet | undefined {
    const cs = this.changeSets.find((c) => c.id === id);
    if (!cs || cs.status !== "open") return cs;
    if (cs.entries.length === 0) {
      this.changeSets = this.changeSets.filter((c) => c.id !== id);
      this.emit();
      return undefined;
    }
    cs.status = "pending";
    if (this.project.settings.permissionMode === "autoKeep") this.keepChangeSet(id);
    else this.emit();
    return cs;
  }

  /** Keep: Claude's edits become one ordinary undo step. */
  keepChangeSet(id: string): boolean {
    const cs = this.changeSets.find((c) => c.id === id);
    if (!cs || (cs.status !== "pending" && cs.status !== "open")) return false;
    cs.status = "kept";
    if (cs.entries.length) {
      this.past.push({
        id: newId("h"),
        label: cs.name,
        source: "claude",
        steps: cs.entries.flatMap((e) => e.steps),
        commands: cs.entries.flatMap((e) => e.commands),
        time: Date.now(),
      });
      this.future = [];
    }
    this.emit();
    return true;
  }

  /**
   * Reject: revert every edit in the change set. Returns the ids of layers
   * I had also edited since (they are restored to their pre-Claude state).
   */
  rejectChangeSet(id: string): { ok: boolean; conflicts: string[] } {
    const cs = this.changeSets.find((c) => c.id === id);
    if (!cs || (cs.status !== "pending" && cs.status !== "open")) return { ok: false, conflicts: [] };
    const conflicts = new Set<string>();
    this.project = backward(this.project, cs.entries.flatMap((e) => e.steps), conflicts);
    cs.status = "rejected";
    this.emit();
    return { ok: true, conflicts: [...conflicts] };
  }

  /** The project as it was before a change set (for before/after preview). */
  projectBefore(id: string): Project {
    const cs = this.changeSets.find((c) => c.id === id);
    if (!cs) return this.project;
    return backward(this.project, cs.entries.flatMap((e) => e.steps));
  }

  /** Run commands and return the result, throwing on failure (scripts/tests). */
  must(cmds: Command | Command[], opts?: DispatchOptions): unknown[] {
    const r = this.dispatch(cmds, opts);
    if (!r.ok) throw new CommandError(r.error);
    return r.results;
  }
}
