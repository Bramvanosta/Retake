/** What a click caused: DOM changes in every tree and the events of a page that reacts. */
import { editableBody, textField } from './fields.js';
import { host } from './host.js';
import { cleanups } from './lifecycle.js';
import { isA, trees } from './trees.js';

// What a click caused (R-FLD-12): DOM changes in every tree (the cursor overlay ignored) and the events of a page that
// reacts (input, change, submit, scroll, toggle, media). Counted from the press on.
const EFFECT_EVENTS = ['input', 'change', 'submit', 'reset', 'scroll', 'toggle', 'beforetoggle', 'play', 'pause', 'copy', 'cut', 'hashchange', 'popstate'];
let effects: { obs: MutationObserver[]; dom: number; first: string; events: Set<string>; take: (list: MutationRecord[]) => void; off: () => void } | null = null;
/** The click-effect watcher stops with the kit (`api.dispose`). */
export function stopEffectsOnDispose(): void {
  cleanups.push(() => effects?.off());
}
export function effectWatch(): void {
  effects?.off();
  const obs: MutationObserver[] = [];
  const events = new Set<string>();
  // The kit's own cursor overlay (raised to the top of the page now and then) is never an effect.
  const own = (n: Node) => n === host;
  // A screenshot hides the text caret with an inline `caret-color` (Playwright's caret: hide): not the page's doing.
  const caretOnly = (m: MutationRecord) => {
    if (m.attributeName !== 'style') return false;
    const bare = (v: string | null) => (v ?? '').replace(/caret-color\s*:[^;]*;?/gi, '').replace(/[\s;]+/g, '');
    return bare(m.oldValue) === bare((m.target as Element).getAttribute('style'));
  };
  const take = (list: MutationRecord[]) => {
    for (const m of list) {
      if (m.target === host || caretOnly(m)) continue;
      if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(own) && m.addedNodes.length + m.removedNodes.length > 0) continue;
      if (state.dom++ === 0) {
        const t = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement;
        state.first = `${m.type}${m.attributeName ? ` ${m.attributeName}` : ''} on ${t ? `${t.localName}${t.id ? `#${t.id}` : ''}` : 'text'}`;
      }
    }
  };
  const docs = new Set<Document>([document]);
  for (const tree of trees(document.documentElement).list) {
    const o = new MutationObserver(take);
    o.observe(tree, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true });
    obs.push(o);
    if (tree.nodeType === 1) docs.add((tree as Element).ownerDocument);
  }
  const onEvent = (e: Event) => {
    // A text field fires `change` when it loses the focus (the field typed into before this click): not the click's doing.
    const t = e.composedPath()[0] as Element | undefined;
    if (e.type === 'change' && t && t.nodeType === 1 && textField(t)) return;
    events.add(e.type);
  };
  // A field taking the focus is what clicking it does (a button taking it is not).
  const onFocus = (e: Event) => {
    const t = e.composedPath()[0] as Element | undefined;
    if (t && t.nodeType === 1 && (isA(t, 'input') || isA(t, 'textarea') || isA(t, 'select') || (t as HTMLElement).isContentEditable === true || editableBody(t))) events.add('focus');
  };
  const wins = [...docs].map((d) => d.defaultView).filter((w): w is Window & typeof globalThis => w !== null);
  for (const w of wins) {
    for (const type of EFFECT_EVENTS) w.addEventListener(type, onEvent, true);
    w.addEventListener('focusin', onFocus, true);
  }
  const off = () => {
    for (const o of obs) o.disconnect();
    for (const w of wins) {
      for (const type of EFFECT_EVENTS) w.removeEventListener(type, onEvent, true);
      w.removeEventListener('focusin', onFocus, true);
    }
  };
  const state = { obs, dom: 0, first: '', events, take, off };
  effects = state;
}
export function effectSeen(): { watching: boolean; dom: number; first: string; events: string[] } {
  if (!effects) return { watching: false, dom: 0, first: '', events: [] };
  for (const o of effects.obs) effects.take(o.takeRecords());
  return { watching: true, dom: effects.dom, first: effects.first, events: [...effects.events] };
}
export function effectStop(): void {
  effects?.off();
  effects = null;
}
