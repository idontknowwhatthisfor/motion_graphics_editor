/**
 * A tiny keyed virtual-DOM for SVG. The renderer rebuilds a description of
 * the frame each tick and this patches only what changed, so scrubbing and
 * playback do not recreate elements (and images do not flicker).
 */
export type Attrs = Record<string, string | number | undefined | null>;
export interface VNode {
  tag: string;
  key: string;
  attrs: Attrs;
  children?: VNode[];
  text?: string;
}

export const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const state = new WeakMap<Element, VNode>();

export function h(tag: string, key: string, attrs: Attrs = {}, children?: VNode[] | string): VNode {
  return typeof children === "string" ? { tag, key, attrs, text: children } : { tag, key, attrs, children };
}

function create(doc: Document, v: VNode): Element {
  const el = v.tag === "video" ? doc.createElementNS(XHTML_NS, v.tag) : doc.createElementNS(SVG_NS, v.tag);
  update(el, undefined, v);
  return el;
}

function setAttr(el: Element, k: string, val: string | number | undefined | null) {
  if (val === undefined || val === null) {
    el.removeAttribute(k);
    return;
  }
  if (k === "href" && el.namespaceURI === SVG_NS) {
    el.setAttribute("href", String(val));
    el.setAttributeNS(XLINK_NS, "xlink:href", String(val));
    return;
  }
  el.setAttribute(k, String(val));
}

function update(el: Element, prev: VNode | undefined, v: VNode) {
  const pa = prev?.attrs ?? {};
  for (const k of Object.keys(pa)) if (!(k in v.attrs)) el.removeAttribute(k);
  for (const [k, val] of Object.entries(v.attrs)) if (pa[k] !== val || !prev) setAttr(el, k, val);
  if (v.text !== undefined) {
    if (prev?.text !== v.text || !prev) el.textContent = v.text;
  } else if (v.children) patchChildren(el, v.children);
  state.set(el, v);
}

/** Make `parent`'s children match `next` (keyed). */
export function patchChildren(parent: Element, next: VNode[]) {
  const doc = parent.ownerDocument;
  const existing = new Map<string, Element>();
  for (const c of Array.from(parent.children)) {
    const v = state.get(c);
    if (v) existing.set(v.key + "|" + v.tag, c);
  }
  next.forEach((v, i) => {
    const id = v.key + "|" + v.tag;
    let el = existing.get(id);
    if (el) {
      existing.delete(id);
      update(el, state.get(el), v);
    } else el = create(doc, v);
    const at = parent.children[i] ?? null;
    if (at !== el) parent.insertBefore(el, at);
  });
  while (parent.children.length > next.length) parent.lastElementChild!.remove();
}
