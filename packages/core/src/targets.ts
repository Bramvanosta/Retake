import type { ScopeSpec, TargetObject, TargetSpec, PointSpec } from './types.js';

/** "#id", ".class", "[attr]" at the start. */
const CSS_START = /^(#[A-Za-z_-]|\.[A-Za-z_-]|\[[A-Za-z_-])/;
/** A lower-case tag directly followed by [attr], .class, #id or :pseudo, without spaces: "li.active", "button:hover". */
const CSS_COMPOUND = /^[a-z][a-z0-9-]*(?:\[[^\]]*\]|\.[A-Za-z_-][\w-]*|#[A-Za-z_-][\w-]*|::?[a-z-]+(?:\([^)]*\))?)+$/;
/** A combinator surrounded by spaces: "form > button", "h2 + p". */
const CSS_COMBINATOR = /\S\s[>+~]\s\S/;

/**
 * True when a bare string looks like a CSS selector rather than visible text.
 * Plain words ("Table", "Save: draft", "Node.js") stay visible text; use {css: …} for bare tag names.
 */
export function looksLikeCss(s: string): boolean {
  const t = s.trim();
  return CSS_START.test(t) || CSS_COMPOUND.test(t) || CSS_COMBINATOR.test(t);
}

/**
 * "Save" → { text: "Save" }; "#import-organization" / ".row > button" → { css }.
 * Objects are returned shallow-copied.
 */
export function normalizeTarget(t: TargetSpec): TargetObject {
  if (typeof t === 'string') {
    return looksLikeCss(t) ? { css: t.trim() } : { text: t };
  }
  return { ...t };
}

export function isPoint(v: unknown): v is PointSpec {
  return typeof v === 'object' && v !== null && typeof (v as PointSpec).x === 'number' && typeof (v as PointSpec).y === 'number' && Object.keys(v).every((k) => k === 'x' || k === 'y');
}

function q(s: string): string {
  return JSON.stringify(s);
}

export function describeScope(s: ScopeSpec): string {
  if (typeof s === 'string') return s;
  if ('row' in s && typeof (s as { row: string }).row === 'string') return `row ${q((s as { row: string }).row)}`;
  return `(${describeTarget(s as TargetObject)})`;
}

/** Short human description: `text="Save" in dialog`, `role=button name="OK" nth=2`. */
export function describeTarget(t: TargetSpec | PointSpec): string {
  if (isPoint(t)) return `point(${t.x},${t.y})`;
  const o = normalizeTarget(t as TargetSpec);
  const parts: string[] = [];
  if (o.text !== undefined) parts.push(`text=${q(o.text)}`);
  if (o.contains !== undefined) {
    const c = Array.isArray(o.contains) ? o.contains : [o.contains];
    parts.push(`contains=[${c.map(q).join(', ')}]`);
  }
  if (o.role !== undefined) parts.push(`role=${o.role}`);
  if (o.name !== undefined) parts.push(`name=${q(o.name)}`);
  if (o.label !== undefined) parts.push(`label=${q(o.label)}`);
  if (o.aria !== undefined) parts.push(`aria=${q(o.aria)}`);
  if (o.placeholder !== undefined) parts.push(`placeholder=${q(o.placeholder)}`);
  if (o.testid !== undefined) parts.push(`testid=${q(o.testid)}`);
  if (o.css !== undefined) parts.push(`css=${q(o.css)}`);
  if (o.nth !== undefined) parts.push(`nth=${o.nth}`);
  if (o.last_visible) parts.push('last_visible');
  if (o.exact) parts.push('exact');
  let s = parts.join(' ') || '(any)';
  if (o.in !== undefined && o.in !== 'page') s += ` in ${describeScope(o.in)}`;
  return s;
}

/** Keys of TargetObject (used to split targets from click options). */
export const TARGET_KEYS = ['text', 'contains', 'role', 'name', 'label', 'aria', 'placeholder', 'css', 'testid', 'in', 'nth', 'last_visible', 'exact'] as const;

/** True if the object carries at least one locating key (text, css, role…). */
export function hasLocator(o: TargetObject): boolean {
  return (
    o.text !== undefined ||
    o.contains !== undefined ||
    o.role !== undefined ||
    o.label !== undefined ||
    o.aria !== undefined ||
    o.placeholder !== undefined ||
    o.css !== undefined ||
    o.testid !== undefined
  );
}

/** Extract only the target keys of an object that mixes target + options. */
export function pickTarget<T extends object>(o: T): TargetObject {
  const out: Record<string, unknown> = {};
  for (const k of TARGET_KEYS) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as TargetObject;
}

// ── Targets in plain words (L4.2) ───────────────────────────────────────────

/** “text” — the curly quotes a reader sees around a word of the page (never markup: the Studio renders text nodes). */
function quoted(s: string): string {
  return `“${s}”`;
}

/** 1st, 2nd, 3rd, 4th… 11th, 12th, 13th, 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

const SCOPE_WORDS: Readonly<Record<string, string>> = { dialog: 'the dialog', menu: 'the menu', listbox: 'the list', popover: 'the popover' };

/** A scope in plain words: "the dialog", "the row containing “Iceland”", or a target's own words. */
export function plainScope(s: ScopeSpec): string {
  if (typeof s === 'string') return SCOPE_WORDS[s] ?? s;
  if (s && typeof s === 'object' && 'row' in s && typeof (s as { row: unknown }).row === 'string') return `the row containing ${quoted((s as { row: string }).row)}`;
  return plainTarget(s as TargetObject);
}

/**
 * A target as a reader says it (L4.2, R-UI-09), next to `describeTarget` (the timeline's and the logs' selector-like
 * form, unchanged): `"Save"` → `“Save”`; `{role: button, name: OK}` → `button “OK”`; `{aria: Increase, in: dialog}` →
 * `“Increase” (aria label) in the dialog`; `{label: Delivery window}` → `field “Delivery window”`; css →
 * `element matching .row > button`; `nth: 1` → `the 2nd …`; a point → `point 640, 360`. Every value as written (a
 * templated `{{shop}}` stays a reference); never throws on a malformed value.
 */
export function plainTarget(t: TargetSpec | PointSpec | unknown): string {
  if (isPoint(t)) return `point ${t.x}, ${t.y}`;
  if (typeof t !== 'string' && (t === null || typeof t !== 'object' || Array.isArray(t))) return t === undefined ? 'the page' : String(JSON.stringify(t));
  const o = normalizeTarget(t as TargetSpec) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const parts: string[] = [];
  const role = str('role');
  const name = str('name');
  if (role !== undefined) parts.push(name !== undefined ? `${role} ${quoted(name)}` : role);
  else if (name !== undefined) parts.push(quoted(name));
  const text = str('text');
  if (text !== undefined) parts.push(quoted(text));
  const label = str('label');
  if (label !== undefined) parts.push(`field ${quoted(label)}`);
  const aria = str('aria');
  if (aria !== undefined) parts.push(`${quoted(aria)} (aria label)`);
  const placeholder = str('placeholder');
  if (placeholder !== undefined) parts.push(`field with placeholder ${quoted(placeholder)}`);
  const testid = str('testid');
  if (testid !== undefined) parts.push(`element with test id ${quoted(testid)}`);
  const css = str('css');
  if (css !== undefined) parts.push(`element matching ${css}`);
  const contains = typeof o.contains === 'string' ? [o.contains] : Array.isArray(o.contains) ? o.contains.filter((c): c is string => typeof c === 'string') : [];
  if (contains.length) parts.push(`element containing ${contains.map(quoted).join(' and ')}`);
  let s = parts.join(', ') || 'any element';
  if (o.exact === true) s += ' (exact)';
  if (typeof o.nth === 'number' && Number.isInteger(o.nth)) s = o.nth >= 0 ? `the ${ordinal(o.nth + 1)} ${s}` : o.nth === -1 ? `the last ${s}` : `the ${ordinal(-o.nth)} from last ${s}`;
  else if (o.last_visible === true) s = `the last visible ${s}`;
  if (o.in !== undefined && o.in !== 'page' && o.in !== null) s += ` in ${plainScope(o.in as ScopeSpec)}`;
  return s;
}
