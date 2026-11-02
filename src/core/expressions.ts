/**
 * Expressions (ED-12): a small, safe formula language for properties.
 *
 * It is NOT JavaScript. Projects can come from Claude or from files, so an
 * expression can only do arithmetic and call the functions below; it cannot
 * reach the page, the network or the file system. It is deterministic (same
 * time -> same value) so preview, frame checks and every export agree.
 *
 * Syntax: numbers, "strings", [arrays], + - * / % ^, comparisons, && || !,
 * cond ? a : b, calls f(x), indexing v[0], and `name = expr;` statements.
 * The last expression is the result. Arrays do element-wise arithmetic, so
 * `value + [10, 0]` moves a position.
 *
 * Variables: value, time, frame, fps, inPoint, outPoint, index, width, height,
 * duration, PI.
 * Functions: wiggle(freq, amp, octaves?, ampMult?), loopOut(type?), loopIn(type?)
 * with type "cycle" | "pingpong" | "offset" | "continue", valueAtTime(t),
 * prop(layerNameOrId, path, t?) to link to another layer's property,
 * linear/ease/easeIn/easeOut(t, tMin, tMax, a, b), clamp, min, max, abs, sin,
 * cos, tan, atan2, sqrt, pow, exp, log, floor, ceil, round, random(seed?),
 * noise(x), length(a, b?), normalize(v), degreesToRadians, radiansToDegrees,
 * mixColor(a, b, t), brand("Primary") for a brand kit colour.
 */
import { lerpColor } from "./color";
import type { AnimValue, Color, Keyframe, Prop } from "./types";

export class ExpressionError extends Error {}

type V = number | string | boolean | V[];

// ---------- tokenizer ----------
type Tok = { k: "num"; v: number } | { k: "str"; v: string } | { k: "id"; v: string } | { k: "op"; v: string } | { k: "end" };
const OPS = ["&&", "||", "==", "!=", "<=", ">=", "**", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", "(", ")", "[", "]", ",", ";", "="];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      out.push({ k: "num", v: parseFloat(num[0]) });
      i += num[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExpressionError("Unclosed string");
      out.push({ k: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected "${c}"`);
    out.push({ k: "op", v: op === "**" ? "^" : op });
    i += op.length;
  }
  out.push({ k: "end" });
  return out;
}

// ---------- parser (Pratt) ----------
type Node =
  | { t: "lit"; v: V }
  | { t: "var"; n: string }
  | { t: "arr"; items: Node[] }
  | { t: "un"; op: string; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "cond"; c: Node; a: Node; b: Node }
  | { t: "call"; f: string; args: Node[] }
  | { t: "idx"; a: Node; i: Node };
type Program = { assigns: { name: string; e: Node }[]; result: Node };

const BP: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "^": 7 };

function parse(src: string): Program {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().k === "op" && (peek() as { v: string }).v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExpressionError(`Expected "${v}"`);
    p++;
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (t.k === "num") return { t: "lit", v: t.v };
    if (t.k === "str") return { t: "lit", v: t.v };
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") return { t: "lit", v: t.v === "true" };
      if (isOp("(")) {
        p++;
        const args: Node[] = [];
        if (!isOp(")")) {
          do args.push(expr(0));
          while (isOp(",") && ++p);
        }
        expect(")");
        return { t: "call", f: t.v, args };
      }
      return { t: "var", n: t.v };
    }
    if (t.k === "op" && t.v === "(") {
      const e = expr(0);
      expect(")");
      return e;
    }
    if (t.k === "op" && t.v === "[") {
      const items: Node[] = [];
      if (!isOp("]")) {
        do items.push(expr(0));
        while (isOp(",") && ++p);
      }
      expect("]");
      return { t: "arr", items };
    }
    if (t.k === "op" && (t.v === "-" || t.v === "!" || t.v === "+")) return { t: "un", op: t.v, a: expr(8) };
    throw new ExpressionError(t.k === "end" ? "Expression ends too early" : `Unexpected "${(t as { v: unknown }).v}"`);
  };
  const postfix = (n: Node): Node => {
    while (isOp("[")) {
      p++;
      const i = expr(0);
      expect("]");
      n = { t: "idx", a: n, i };
    }
    return n;
  };
  function expr(minBp: number): Node {
    let left = postfix(primary());
    for (;;) {
      const t = peek();
      if (t.k !== "op") break;
      if (t.v === "?" && minBp === 0) {
        p++;
        const a = expr(0);
        expect(":");
        const b = expr(0);
        left = { t: "cond", c: left, a, b };
        continue;
      }
      const bp = BP[t.v];
      if (bp === undefined || bp <= minBp) break;
      p++;
      // ^ is right-associative
      const right = expr(t.v === "^" ? bp - 1 : bp);
      left = { t: "bin", op: t.v, a: left, b: right };
    }
    return left;
  }
  const assigns: Program["assigns"] = [];
  let result: Node | null = null;
  while (peek().k !== "end") {
    const t = peek();
    if (t.k === "id" && toks[p + 1].k === "op" && (toks[p + 1] as { v: string }).v === "=") {
      p += 2;
      assigns.push({ name: t.v, e: expr(0) });
    } else result = expr(0);
    if (isOp(";")) p++;
    else if (peek().k !== "end") throw new ExpressionError(`Unexpected "${(peek() as { v: unknown }).v}"`);
  }
  if (!result) {
    if (!assigns.length) throw new ExpressionError("Empty expression");
    result = { t: "var", n: assigns[assigns.length - 1].name };
  }
  return { assigns, result };
}

const cache = new Map<string, Program>();
function compile(src: string): Program {
  let prog = cache.get(src);
  if (!prog) {
    prog = parse(src);
    if (cache.size > 500) cache.clear();
    cache.set(src, prog);
  }
  return prog;
}

/** Throws ExpressionError with a readable message when the syntax is wrong. */
export function checkSyntax(src: string): void {
  compile(src);
}

// ---------- deterministic noise ----------
function hash(n: number): number {
  let x = Math.imul(n | 0, 0x27d4eb2d) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}
/** Smooth 1D gradient noise in [-1, 1]. */
export function noise1(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const g = (k: number) => hash(seed * 31 + k) * 2 - 1;
  const a = g(i) * f;
  const b = g(i + 1) * (f - 1);
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return (a + (b - a) * u) * 2;
}

// ---------- evaluation ----------
export interface ExprContext {
  /** The property's own value at `time` (keyframes, before the expression). */
  value: AnimValue;
  time: number;
  prop: Prop;
  /** Seed for wiggle/random: stable per layer + property. */
  seed: number;
  vars: Record<string, number>;
  /** Value of the same property (without its expression) at another time. */
  rawAt(t: number): AnimValue;
  /** Linked property value (with its expression) or throws. */
  link(layer: string, path: string, t: number): AnimValue;
  /** Brand kit colours by name (ED-15). */
  brand?: Record<string, string>;
}

const num = (v: V, what: string): number => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "number") throw new ExpressionError(`${what} needs a number`);
  return v;
};
function arith(op: string, a: V, b: V): V {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (typeof a === "string" || typeof b === "string") throw new ExpressionError("Cannot do arithmetic with a colour; use mixColor");
    const n = Math.max(Array.isArray(a) ? a.length : 0, Array.isArray(b) ? b.length : 0);
    const at = (x: V, i: number): V => (Array.isArray(x) ? (x[i] ?? 0) : x);
    return Array.from({ length: n }, (_, i) => arith(op, at(a, i), at(b, i)));
  }
  if (op === "+" && (typeof a === "string" || typeof b === "string")) return String(a) + String(b);
  const x = num(a, op);
  const y = num(b, op);
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return x / y;
    case "%":
      return x % y;
    case "^":
      return Math.pow(x, y);
  }
  throw new ExpressionError(`Unknown operator ${op}`);
}
const truthy = (v: V) => (Array.isArray(v) ? v.length > 0 : !!v);
const eq = (a: V, b: V): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => eq(x, b[i])) : a === b);

const ease3 = (u: number) => u * u * (3 - 2 * u);
function interp(args: V[], shape: (u: number) => number): V {
  let t: number, t0: number, t1: number, a: V, b: V;
  if (args.length === 3) [t, t0, t1, a, b] = [num(args[0], "t"), 0, 1, args[1], args[2]];
  else if (args.length === 5) [t, t0, t1, a, b] = [num(args[0], "t"), num(args[1], "tMin"), num(args[2], "tMax"), args[3], args[4]];
  else throw new ExpressionError("linear/ease take (t, tMin, tMax, a, b) or (t, a, b)");
  const u = shape(t1 === t0 ? (t >= t1 ? 1 : 0) : Math.max(0, Math.min(1, (t - t0) / (t1 - t0))));
  if (typeof a === "string" && typeof b === "string") return lerpColor(a as Color, b as Color, u);
  return arith("+", a, arith("*", arith("-", b, a), u));
}

function loop(ctx: ExprContext, args: V[], out: boolean): V {
  const type = args.length ? String(args[0]) : "cycle";
  const kfs = (ctx.prop.keyframes ?? []) as Keyframe[];
  if (kfs.length < 2) return ctx.value as V;
  const first = kfs[0];
  const last = kfs[kfs.length - 1];
  const span = last.t - first.t;
  const t = ctx.time;
  if (span <= 0 || (out ? t <= last.t : t >= first.t)) return ctx.value as V;
  const rel = out ? t - first.t : last.t - t;
  const cycles = Math.floor(rel / span);
  const phase = rel - cycles * span;
  const raw = (x: number) => ctx.rawAt(x) as V;
  switch (type) {
    case "pingpong": {
      const fwd = cycles % 2 === 0;
      if (out) return raw(fwd ? first.t + phase : last.t - phase);
      return raw(fwd ? last.t - phase : first.t + phase);
    }
    case "offset": {
      const delta = arith("-", last.v as V, first.v as V);
      if (out) return arith("+", raw(first.t + phase), arith("*", delta, cycles));
      return arith("-", raw(last.t - phase), arith("*", delta, cycles));
    }
    case "continue": {
      const eps = 1 / 1000;
      if (out) {
        const vel = arith("/", arith("-", last.v as V, raw(last.t - eps)), eps);
        return arith("+", last.v as V, arith("*", vel, t - last.t));
      }
      const vel = arith("/", arith("-", raw(first.t + eps), first.v as V), eps);
      return arith("-", first.v as V, arith("*", vel, first.t - t));
    }
    case "cycle":
      return out ? raw(first.t + phase) : raw(last.t - phase);
    default:
      throw new ExpressionError(`Unknown loop type "${type}" (cycle, pingpong, offset, continue)`);
  }
}

const MATH1: Record<string, (x: number) => number> = {
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  exp: Math.exp,
  log: Math.log,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  degreesToRadians: (d) => (d * Math.PI) / 180,
  radiansToDegrees: (r) => (r * 180) / Math.PI,
};

function call(ctx: ExprContext, f: string, args: V[]): V {
  if (f in MATH1) {
    if (Array.isArray(args[0])) return args[0].map((x) => MATH1[f](num(x, f)));
    return MATH1[f](num(args[0], f));
  }
  switch (f) {
    case "wiggle": {
      const freq = num(args[0] ?? 1, "wiggle frequency");
      const amp = args[1] ?? 0;
      const oct = Math.max(1, Math.min(8, Math.round(num(args[2] ?? 1, "octaves"))));
      const mult = num(args[3] ?? 0.5, "ampMult");
      const t = num(args[4] ?? ctx.time, "time");
      const base = ctx.value as V;
      const dims = Array.isArray(base) ? base.length : 1;
      if (typeof base === "string") throw new ExpressionError("wiggle works on numbers and positions, not colours");
      const off = Array.from({ length: dims }, (_, d) => {
        let s = 0;
        let a = 1;
        for (let o = 0; o < oct; o++, a *= mult) s += noise1(ctx.seed + d * 7919 + o * 104729, t * freq * 2 ** o) * a;
        return s;
      });
      const ampV = (d: number) => (Array.isArray(amp) ? num(amp[d] ?? 0, "amp") : num(amp, "amp"));
      return Array.isArray(base) ? base.map((b, d) => num(b, "value") + off[d] * ampV(d)) : num(base, "value") + off[0] * ampV(0);
    }
    case "loopOut":
      return loop(ctx, args, true);
    case "loopIn":
      return loop(ctx, args, false);
    case "valueAtTime":
      return ctx.rawAt(num(args[0], "valueAtTime")) as V;
    case "prop":
      if (args.length < 2) throw new ExpressionError('prop needs (layer, path), e.g. prop("Title", "transform.position")');
      return ctx.link(String(args[0]), String(args[1]), args[2] === undefined ? ctx.time : num(args[2], "time")) as V;
    case "linear":
      return interp(args, (u) => u);
    case "ease":
      return interp(args, ease3);
    case "easeIn":
      return interp(args, (u) => u * u);
    case "easeOut":
      return interp(args, (u) => 1 - (1 - u) * (1 - u));
    case "clamp": {
      const lo = args[1];
      const hi = args[2];
      const c = (x: V, i: number): V => Math.max(num(Array.isArray(lo) ? lo[i] : lo, "clamp"), Math.min(num(Array.isArray(hi) ? hi[i] : hi, "clamp"), num(x, "clamp")));
      return Array.isArray(args[0]) ? args[0].map(c) : c(args[0], 0);
    }
    case "min":
    case "max":
      return Math[f](...args.map((a) => num(a, f)));
    case "atan2":
      return Math.atan2(num(args[0], f), num(args[1], f));
    case "pow":
      return Math.pow(num(args[0], f), num(args[1], f));
    case "random": {
      const s = args.length ? Math.round(num(args[0], "seed") * 1000) : ctx.seed;
      return hash(s ^ 0x5bd1e995);
    }
    case "noise":
      return noise1(0, num(args[0], "noise")) / 2;
    case "length": {
      const a = args[0];
      const v = args.length > 1 ? arith("-", a, args[1]) : a;
      return Array.isArray(v) ? Math.hypot(...v.map((x) => num(x, "length"))) : Math.abs(num(v, "length"));
    }
    case "normalize": {
      const v = args[0];
      if (!Array.isArray(v)) throw new ExpressionError("normalize needs a vector");
      const l = Math.hypot(...v.map((x) => num(x, "normalize"))) || 1;
      return v.map((x) => num(x, "normalize") / l);
    }
    case "brand": {
      const name = String(args[0] ?? "");
      const c = ctx.brand?.[name] ?? Object.entries(ctx.brand ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
      if (!c) throw new ExpressionError(`No brand colour named "${name}"`);
      return c;
    }
    case "mixColor":
      return lerpColor(String(args[0]) as Color, String(args[1]) as Color, Math.max(0, Math.min(1, num(args[2], "mixColor"))));
  }
  throw new ExpressionError(`Unknown function ${f}()`);
}

function run(ctx: ExprContext, n: Node, scope: Record<string, V>, budget: { n: number }): V {
  if (--budget.n < 0) throw new ExpressionError("Expression is too complex");
  switch (n.t) {
    case "lit":
      return n.v;
    case "var":
      if (n.n in scope) return scope[n.n];
      throw new ExpressionError(`Unknown name "${n.n}"`);
    case "arr":
      return n.items.map((x) => run(ctx, x, scope, budget));
    case "un": {
      const a = run(ctx, n.a, scope, budget);
      if (n.op === "!") return !truthy(a);
      return n.op === "-" ? arith("*", a, -1) : a;
    }
    case "bin": {
      if (n.op === "&&") return truthy(run(ctx, n.a, scope, budget)) ? run(ctx, n.b, scope, budget) : false;
      if (n.op === "||") {
        const a = run(ctx, n.a, scope, budget);
        return truthy(a) ? a : run(ctx, n.b, scope, budget);
      }
      const a = run(ctx, n.a, scope, budget);
      const b = run(ctx, n.b, scope, budget);
      switch (n.op) {
        case "==":
          return eq(a, b);
        case "!=":
          return !eq(a, b);
        case "<":
          return num(a, "<") < num(b, "<");
        case ">":
          return num(a, ">") > num(b, ">");
        case "<=":
          return num(a, "<=") <= num(b, "<=");
        case ">=":
          return num(a, ">=") >= num(b, ">=");
      }
      return arith(n.op, a, b);
    }
    case "cond":
      return truthy(run(ctx, n.c, scope, budget)) ? run(ctx, n.a, scope, budget) : run(ctx, n.b, scope, budget);
    case "call":
      return call(
        ctx,
        n.f,
        n.args.map((x) => run(ctx, x, scope, budget)),
      );
    case "idx": {
      const a = run(ctx, n.a, scope, budget);
      const i = num(run(ctx, n.i, scope, budget), "index");
      if (!Array.isArray(a)) throw new ExpressionError("Only arrays can be indexed");
      return a[Math.floor(i)] ?? 0;
    }
  }
}

/** Evaluate an expression; the result is coerced to the property's kind or an error is thrown. */
export function evaluateExpression(src: string, ctx: ExprContext): AnimValue {
  const prog = compile(src);
  const scope: Record<string, V> = { ...ctx.vars, value: ctx.value as V, time: ctx.time, PI: Math.PI };
  const budget = { n: 20000 };
  for (const a of prog.assigns) scope[a.name] = run(ctx, a.e, scope, budget);
  const r = run(ctx, prog.result, scope, budget);
  const base = ctx.value;
  if (typeof base === "number") {
    const x = Array.isArray(r) ? r[0] : r;
    const v = num(x as V, "The result");
    if (!Number.isFinite(v)) throw new ExpressionError("The result is not a finite number");
    return v;
  }
  if (typeof base === "string") {
    if (typeof r !== "string" || !/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(r)) throw new ExpressionError('The result must be a colour like "#ff8800"');
    return r;
  }
  if (Array.isArray(base)) {
    const arr = Array.isArray(r) ? r : [r, r];
    const v: [number, number] = [num(arr[0] ?? 0, "The result"), num(arr[1] ?? 0, "The result")];
    if (!v.every(Number.isFinite)) throw new ExpressionError("The result is not finite");
    return v;
  }
  throw new ExpressionError("Expressions work on numbers, positions/sizes and colours");
}
