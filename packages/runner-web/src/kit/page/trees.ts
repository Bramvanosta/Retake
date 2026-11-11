/** Trees: open shadow roots and same-origin frames; boxes and points in top-level viewport px. */
import { host } from './host.js';
import { memo } from './memo.js';

// ─────────────────────── trees: open shadow roots and same-origin frames (R-ISS-07) ───────────────────────
// This kit (the top one) searches, hit-tests, scrolls and clicks inside open shadow roots and same-origin frames
// itself. Every coordinate crossing the kit boundary is in TOP-LEVEL viewport CSS px: an element in a frame is offset
// by the frames' content-box positions. Elements of a frame belong to another realm: no `instanceof`, no bare
// getComputedStyle, no top-realm constructors for them (isA, styleOf, winOf).
type Tree = Element | ShadowRoot;
export const winOf = (n: Node): Window => (n.ownerDocument ?? (n as Document)).defaultView ?? window;
export const styleOf = (el: Element): CSSStyleDeclaration => winOf(el).getComputedStyle(el);
/** Realm-safe `instanceof HTMLxxxElement`. */
export function isA<K extends keyof HTMLElementTagNameMap>(el: unknown, name: K): el is HTMLElementTagNameMap[K] {
  return !!el && (el as Node).nodeType === 1 && (el as Element).localName === name && (el as Element).namespaceURI === 'http://www.w3.org/1999/xhtml';
}
/** The document of a same-origin iframe/frame (null when cross-origin, sandboxed or not created yet). Never throws. */
export function frameDoc(el: Element): Document | null {
  if (el.localName !== 'iframe' && el.localName !== 'frame') return null;
  try {
    const d = (el as HTMLIFrameElement).contentDocument;
    return d && d.documentElement ? d : null;
  } catch {
    return null;
  }
}
/** The frame element holding a (non-top) document. */
export function frameElOf(doc: Document): Element | null {
  if (doc === document) return null;
  try {
    return doc.defaultView?.frameElement ?? null;
  } catch {
    return null;
  }
}
/** The host of the node's shadow root, else the frame element of its document; null in the top document. */
function outerOf(n: Node): Element | null {
  const root = n.getRootNode();
  if (root.nodeType === 11) return (root as ShadowRoot).host;
  return root.nodeType === 9 ? frameElOf(root as Document) : null;
}
/** Parent in the flat (rendered) tree within one document: a slotted element's slot, else its parent or host. */
export function flatParent(el: Element): Element | null {
  const slot = el.assignedSlot;
  if (slot) return slot;
  if (el.parentElement) return el.parentElement;
  const p = el.parentNode;
  return p && p.nodeType === 11 ? (p as ShadowRoot).host : null;
}
/** Parent or shadow host (no slot hop): the composed DOM parent within one document. */
export function hostParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const p = el.parentNode;
  return p && p.nodeType === 11 ? (p as ShadowRoot).host : null;
}
/** Flat-tree parent, going out of a frame document to its frame element. */
export function upOf(el: Element): Element | null {
  return flatParent(el) ?? (el === el.ownerDocument.documentElement ? frameElOf(el.ownerDocument) : null);
}
/** `outer` holds `inner`, through shadow roots, slots and frames. */
export function deepContains(outer: Element, inner: Element | null): boolean {
  if (!inner) return false;
  if (outer.contains(inner)) return true;
  for (let n: Element | null = upOf(inner), i = 0; n && i < 4096; n = upOf(n), i++) if (n === outer) return true;
  return false;
}
/** `closest` along the flat tree, going out through shadow hosts, slots and frame elements. */
export function deepClosest(el: Element | null, sel: string): Element | null {
  for (let n = el, i = 0; n && i < 4096; n = upOf(n), i++) if (n.matches(sel)) return n;
  return null;
}
/**
 * The trees to search under `root`: the root itself, then every open shadow root and same-origin frame document
 * (its body) found inside, recursively. Closed shadow roots (the kit's own overlay included) are invisible; frames
 * that cannot be entered are counted (`cross`) for the not-found message.
 */
export function trees(root: Element): { list: Tree[]; cross: number } {
  const cached = memo?.trees.get(root);
  if (cached) return cached;
  const list: Tree[] = [root];
  let cross = 0;
  const scan = (scope: Tree, depth: number) => {
    const one = (el: Element) => {
      const sr = el.shadowRoot;
      if (sr && el !== host && depth < 16) {
        list.push(sr);
        scan(sr, depth + 1);
      }
      if (el.localName === 'iframe' || el.localName === 'frame') {
        const d = frameDoc(el);
        const b = d ? (d.body ?? d.documentElement) : null;
        if (b && depth < 16) {
          list.push(b);
          scan(b, depth + 1);
        } else if (!d) {
          const src = el.getAttribute('src') ?? '';
          if (src && !/^about:/i.test(src)) cross++;
        }
      }
    };
    if (scope.nodeType === 1) one(scope as Element);
    const all = scope.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) one(all[i]);
  };
  scan(root, 0);
  const out = { list, cross };
  memo?.trees.set(root, out);
  return out;
}
/** Anchors of an element from the top document down: [outermost host/frame, …, el]. */
function anchors(el: Element): Element[] {
  const out = [el];
  for (let o = outerOf(el), i = 0; o && i < 64; o = outerOf(o), i++) out.unshift(o);
  return out;
}
/** Composed visual order: a host or frame precedes what it holds (its shadow content before its slotted content). */
export function deepCompare(a: Element, b: Element): number {
  if (a === b) return 0;
  if (a.getRootNode() !== b.getRootNode()) {
    const ca = anchors(a);
    const cb = anchors(b);
    let i = 0;
    while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
    if (i === ca.length) return -1;
    if (i === cb.length) return 1;
    a = ca[i];
    b = cb[i];
  }
  const pos = a.compareDocumentPosition(b);
  return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
}
/** querySelectorAll in every tree under `root` (and `root` itself when `withRoot`), in composed order. */
export function deepQsa(root: Element | Document, sel: string, withRoot = false): Element[] {
  const start = root.nodeType === 9 ? (root as Document).documentElement : (root as Element);
  if (!start) return [];
  if (memo) {
    const key = `${withRoot ? '1' : '0'}${sel}`;
    let bySel = memo.qsa.get(key);
    if (!bySel) memo.qsa.set(key, (bySel = new Map()));
    let hit = bySel.get(start);
    if (!hit) bySel.set(start, (hit = deepQsaLive(start, sel, withRoot)));
    return hit.slice();
  }
  return deepQsaLive(start, sel, withRoot);
}
function deepQsaLive(start: Element, sel: string, withRoot: boolean): Element[] {
  const { list } = trees(start);
  const out: Element[] = withRoot && start.matches(sel) ? [start] : [];
  if (list.length === 1) {
    out.push(...Array.from(start.querySelectorAll(sel)));
    return out;
  }
  for (const t of list) {
    if (t !== start && t.nodeType === 1 && (t as Element).matches(sel)) out.push(t as Element);
    out.push(...Array.from(t.querySelectorAll(sel)));
  }
  return out.sort(deepCompare);
}
/** Position of a frame's content box in its own document's viewport. */
export function contentOffset(f: Element): { x: number; y: number } {
  const r = f.getBoundingClientRect();
  const cs = styleOf(f);
  return { x: r.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0), y: r.top + f.clientTop + (parseFloat(cs.paddingTop) || 0) };
}
/** Offset of a node's document viewport in the top viewport (0 in the top document). */
export function frameOffset(n: Node): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let doc = n.ownerDocument ?? (n as Document);
  for (let i = 0; doc !== document && i < 16; i++) {
    const f = frameElOf(doc);
    if (!f) break;
    const o = contentOffset(f);
    x += o.x;
    y += o.y;
    doc = f.ownerDocument;
  }
  return { x, y };
}
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
/** getBoundingClientRect in top-level viewport px. */
export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  if (el.ownerDocument === document) return r;
  const o = frameOffset(el);
  return { left: r.left + o.x, top: r.top + o.y, right: r.right + o.x, bottom: r.bottom + o.y, width: r.width, height: r.height };
}
/** elementFromPoint (top px) that pierces open shadow roots and same-origin frames: the innermost element. */
export function deepHit(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  let lx = x;
  let ly = y;
  for (let i = 0; hit && i < 32; i++) {
    const sr = hit.shadowRoot;
    if (sr && hit !== host) {
      const inner = sr.elementFromPoint(lx, ly);
      // Inside the shadow tree, or a slotted light descendant of the host.
      if (inner && inner !== hit && (sr.contains(inner) || hit.contains(inner))) {
        hit = inner;
        continue;
      }
      break;
    }
    const d = frameDoc(hit);
    if (!d) break;
    const o = contentOffset(hit);
    const inner = d.elementFromPoint(lx - o.x, ly - o.y);
    if (!inner) break; // on the frame's border or padding
    lx -= o.x;
    ly -= o.y;
    hit = inner;
  }
  return hit;
}
/** The focused element, through open shadow roots and same-origin frames. */
export function deepActive(): Element | null {
  let el: Element | null = document.activeElement;
  for (let i = 0; el && i < 32; i++) {
    const inner = el.shadowRoot?.activeElement ?? frameDoc(el)?.activeElement ?? null;
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}
