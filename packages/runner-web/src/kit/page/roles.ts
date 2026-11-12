/** Roles and accessible names. */
import { memo } from './memo.js';
import { BUTTON_INPUT, norm } from './text.js';
import { deepClosest, deepQsa, hostParent, isA } from './trees.js';

// ───────────────────────────── roles & names ─────────────────────────────
export const IMPLICIT: Record<string, string> = {
  button: 'button,input[type=button],input[type=submit],input[type=reset],input[type=image],summary',
  link: 'a[href],area[href]',
  textbox: 'input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=password],input[type=search],textarea,[contenteditable=""],[contenteditable=true]',
  searchbox: 'input[type=search]',
  combobox: 'select:not([multiple]):not([size]),input[list]',
  listbox: 'select[multiple],select[size],datalist',
  checkbox: 'input[type=checkbox]',
  radio: 'input[type=radio]',
  option: 'option',
  heading: 'h1,h2,h3,h4,h5,h6',
  dialog: 'dialog',
  row: 'tr',
  cell: 'td',
  columnheader: 'th',
  table: 'table',
  list: 'ul,ol',
  listitem: 'li',
  img: 'img[alt]:not([alt=""])',
  navigation: 'nav',
  main: 'main',
  form: 'form',
  slider: 'input[type=range]',
  spinbutton: 'input[type=number]',
  progressbar: 'progress',
  article: 'article',
  banner: 'header',
  contentinfo: 'footer',
  complementary: 'aside',
  group: 'fieldset,details',
};
const ROLE_ALIASES: Record<string, string[]> = {
  menuitem: ['menuitem', 'menuitemcheckbox', 'menuitemradio'],
  textbox: ['textbox', 'searchbox'],
};
export function explicitRole(el: Element): string | null {
  const r = el.getAttribute('role');
  if (!r) return null;
  const first = r.trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}
export function roleOf(el: Element): string | null {
  const ex = explicitRole(el);
  if (ex) return ex;
  for (const [role, sel] of Object.entries(IMPLICIT)) {
    if (role === 'searchbox') continue; // reported as textbox-compatible below
    if (el.matches(sel)) return el.matches(IMPLICIT.searchbox) ? 'searchbox' : role;
  }
  return null;
}
export function hasRole(el: Element, role: string): boolean {
  const wanted = ROLE_ALIASES[role] ?? [role];
  const r = roleOf(el);
  return r !== null && wanted.includes(r);
}
export function byRole(root: Element, role: string): Element[] {
  const wanted = ROLE_ALIASES[role] ?? [role];
  const sels: string[] = [];
  for (const r of wanted) {
    sels.push(`[role="${r}"]`, `[role^="${r} "]`);
    if (IMPLICIT[r]) sels.push(IMPLICIT[r]);
  }
  const sel = sels.join(',');
  const out: Element[] = [];
  for (const el of deepQsa(root, sel, true)) if (hasRole(el, role)) out.push(el);
  return out;
}
/** The tree (document or shadow root) of a node: ids resolve there. */
export function treeOf(n: Node): Document | ShadowRoot {
  const r = n.getRootNode();
  return r.nodeType === 9 || r.nodeType === 11 ? (r as Document | ShadowRoot) : (n.ownerDocument ?? document);
}
/** What a field holds (its value, its options, what was typed into it): never part of a name or a label. */
export const FIELD_CONTENT =
  'textarea,select,option,optgroup,datalist,script,style,template,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=spinbutton],[role=slider],[role=listbox],[role=combobox]';
/** Fields drawn without a form control whose content is a value: never their name. */
const TYPED_SEL = '[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=spinbutton],[role=slider]';
/**
 * The text of a label or of an element `aria-labelledby` points at, as a name computation reads it: without the
 * content of a field inside it (a textarea's text, a select's options, an edited region) and without `self` (the
 * element named — `aria-labelledby` may include it).
 */
export function nameText(node: Element, self: Element | null = null): string {
  if (node === self || node.matches(FIELD_CONTENT)) return '';
  if (!(self && node.contains(self)) && !node.querySelector(FIELD_CONTENT)) return node.textContent ?? '';
  let out = '';
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === 3) out += c.textContent ?? '';
    else if (c.nodeType === 1) out += nameText(c as Element, self);
  }
  return out;
}
export function idsText(ids: string, from: Node = document, self: Element | null = null): string {
  const tree = treeOf(from);
  return norm(
    ids
      .split(/\s+/)
      .map((id) => {
        const ref = id ? tree.getElementById(id) : null;
        return ref ? nameText(ref, self) : '';
      })
      .join(' '),
  );
}
export function accessibleName(el: Element): string {
  if (!memo) return accessibleNameLive(el);
  let v = memo.names.get(el);
  if (v === undefined) memo.names.set(el, (v = accessibleNameLive(el)));
  return v;
}
function accessibleNameLive(el: Element): string {
  const lb = el.getAttribute('aria-labelledby');
  if (lb) {
    const t = idsText(lb, el, el);
    if (t) return t;
  }
  const al = el.getAttribute('aria-label');
  if (al && norm(al)) return norm(al);
  if (isA(el, 'input') || isA(el, 'select') || isA(el, 'textarea')) {
    const labels = el.labels
      ? Array.from(el.labels)
          .map((l) => norm(nameText(l, el)))
          .filter(Boolean)
      : [];
    if (labels.length) return labels.join(' ');
    if (isA(el, 'input') && el.matches(BUTTON_INPUT)) return norm(el.value);
    const t = el.getAttribute('title') ?? el.getAttribute('placeholder');
    return norm(t);
  }
  if (isA(el, 'img')) return norm(el.alt);
  // A text field drawn with ARIA or contenteditable is not named by what it holds (that is its value).
  if (el.matches(TYPED_SEL)) return norm(el.getAttribute('title') ?? el.getAttribute('aria-placeholder') ?? el.getAttribute('placeholder'));
  // Named from its content: what a field inside it holds is not part of it (a label wrapping a textarea).
  const t = norm(nameText(el));
  if (t) return t;
  return norm(el.getAttribute('title'));
}

export const INTERACTIVE =
  'button,a[href],input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=spinbutton],[role=slider],[role=treeitem],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';
export function promote(el: Element, root: Element): Element {
  let cur: Element | null = el;
  for (let i = 0; cur && i <= 6; i++) {
    if (cur.matches(INTERACTIVE)) return cur;
    if (cur === root) break;
    // Out of a shadow root to its host, never out of a frame.
    cur = hostParent(cur);
  }
  return el;
}
export function isInteractive(el: Element): boolean {
  return deepClosest(el, INTERACTIVE) !== null;
}
