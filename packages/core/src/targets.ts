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
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PointSpec).x === 'number' &&
    typeof (v as PointSpec).y === 'number' &&
    Object.keys(v).every((k) => k === 'x' || k === 'y')
  );
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
export const TARGET_KEYS = [
  'text',
  'contains',
  'role',
  'name',
  'label',
  'aria',
  'placeholder',
  'css',
  'testid',
  'in',
  'nth',
  'last_visible',
  'exact',
] as const;

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
