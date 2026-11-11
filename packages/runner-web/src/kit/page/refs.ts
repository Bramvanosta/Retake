/** Element refs: an id per element, held weakly. */
// ───────────────────────────── element refs ─────────────────────────────
const refs = new Map<string, WeakRef<Element>>();
const refOf = new WeakMap<Element, string>();
let refSeq = 0;
export function ref(el: Element): string {
  const existing = refOf.get(el);
  if (existing && refs.get(existing)?.deref() === el) return existing;
  if (refs.size > 4000) {
    for (const [k, v] of refs) if (!v.deref()?.isConnected) refs.delete(k);
  }
  const id = `r${++refSeq}`;
  refs.set(id, new WeakRef(el));
  refOf.set(el, id);
  return id;
}
export function deref(id: string | null | undefined): Element | null {
  if (!id) return null;
  const el = refs.get(id)?.deref() ?? null;
  // A frame that navigated or was removed keeps its old elements connected to a document without a window: gone.
  return el && el.isConnected && el.ownerDocument.defaultView ? el : null;
}
