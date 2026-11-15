/** What a recorded element and its text may become in a draft (recording.ts): its target, its alternatives, a scene's id and `open:`. */
import { sameTarget, targetValue } from './inspect.js';
import type { El, Ev, Step, StepMeta } from './recording-draft.js';
import { SECRET_FIELD_KINDS } from './recording-events.js';
import type { RecordedElement } from './recording-events.js';
import { firstHiddenChar } from './scenario-edit.js';
import { normalizeTarget } from './targets.js';
import type { TargetObject, TargetSpec } from './types/language.js';
import { decodeOrKeep } from './util.js';

export const ACTION_KINDS = new Set(['pointer', 'dblclick', 'type', 'select_native', 'file', 'key']);
/** Elements whose text is a whole region, never a press target. */
export const CONTAINER_ROLES = new Set([
  'dialog',
  'alertdialog',
  'document',
  'main',
  'region',
  'navigation',
  'banner',
  'contentinfo',
  'form',
  'list',
  'grid',
  'table',
  'rowgroup',
  'tabpanel',
  'group',
]);
export const CONFIRM_WORD = /^(yes|ok|confirm|continue)\b/i;
export const MASK = '•••';
/** The opening of a template (`{{vars.x}}`, `{{env:X}}`): a recorded string holding one is never put in a draft. */
export const TEMPLATE = '{{';
/** The draft's own secret placeholders (the only templates it writes). */
export const PLACEHOLDER_RE = new RegExp(`\\{\\{vars\\.(?:${SECRET_FIELD_KINDS.join('|')})_\\d+\\}\\}`, 'g');

export const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
export const hasMask = (v: unknown): boolean => JSON.stringify(v ?? null).includes(MASK);
export const hasTemplate = (v: unknown): boolean => JSON.stringify(v ?? null).includes(TEMPLATE);
/**
 * A recorded string holding a hidden character — a control, a zero-width or direction character, a line or paragraph
 * separator: the set no Studio write ever adds (core scenario-edit.ts). In a draft it would read as another
 * text or target than the one it holds (an editor or a diff shows it reordered or invisible).
 */
export const hidden = (s: string): boolean => firstHiddenChar(s) !== undefined;
/** Any string inside `v` holding a hidden character. */
export function hasHidden(v: unknown): boolean {
  if (typeof v === 'string') return hidden(v);
  if (Array.isArray(v)) return v.some(hasHidden);
  if (v !== null && typeof v === 'object') return Object.values(v).some(hasHidden);
  return false;
}
/** A recorded string that cannot go into a draft as it is: masked (a secret), holding a template or a hidden character. */
export const unsafe = (s: string): boolean => s.includes(MASK) || s.includes(TEMPLATE) || hidden(s);
/** The element as the recorder described it, its alternatives aside (they never change what the press was). */
export function bare(el: El): Omit<El, 'alternatives' | 'alternatives_partial'> {
  const { alternatives: _a, alternatives_partial: _p, ...rest } = el;
  return rest;
}

/** A scenario target from a verified one (the bare string for a lone text), or null when it is missing, masked or templated. */
export function targetOf(el: El | null): TargetSpec | null {
  if (!el?.target || hasMask(el.target) || hasTemplate(el.target) || hasHidden(el.target)) return null;
  return targetValue(el.target);
}

/**
 * The alternatives of an element the person may pick, with their 1-based index in `el.alternatives`: none when
 * the element's own target is not usable or it is a secret field; never one that is masked, templated, holding a
 * hidden character or the same as the suggested target.
 */
export function recordedAlternatives(el: RecordedElement | null | undefined): Array<{ index: number; target: TargetSpec; fragile: Array<'broader' | 'dynamic_text' | 'css'> }> {
  if (!el?.alternatives || el.secret || targetOf(el) === null) return [];
  const main = el.target as TargetObject;
  return el.alternatives.flatMap((a, i) =>
    hasMask(a.target) || hasTemplate(a.target) || hasHidden(a.target) || a.target.nth !== undefined || sameTarget(a.target, main)
      ? []
      : [{ index: i + 1, target: targetValue(a.target), fragile: [...a.fragile] }],
  );
}

/** The accessible name a list option / menu item is chosen by. */
export function itemName(el: El): string {
  return clean(el.name) || clean(el.label) || clean(el.text);
}

export const sameEl = (a: El | null, b: El | null): boolean => !!a?.target && !!b?.target && sameTarget(a.target, b.target);

/** A `click` step on `t` (no options): the press that focused a field, folded into its `type` / `select`. */
export function isClickOn(s: Step | undefined, t: TargetSpec): boolean {
  if (!s || !('click' in s)) return false;
  const c = s.click;
  if (typeof c !== 'string' && (c === null || typeof c !== 'object')) return false;
  return sameTarget(normalizeTarget(c as TargetSpec), normalizeTarget(t));
}

/** The path of `path` under the base path of environment page `key` ("/" when it is the base itself). */
export function pathUnderPage(path: string, key: string, pages: Record<string, string>): string {
  let base = '';
  try {
    base = new URL(pages[key] ?? '').pathname.replace(/\/+$/, '');
  } catch {
    base = '';
  }
  if (base && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length);
  return path.startsWith('/') ? path : `/${path}`;
}

/** A scene id from a path's first meaningful segment (`/products/x` → products; `/` → home). */
export function sceneIdOf(path: string): string {
  const seg = path
    .split('/')
    .map(decodeOrKeep)
    .find((s) => s && !/^\d+$/.test(s) && !/^[0-9a-f-]{16,}$/i.test(s));
  const slug = (seg ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || (seg === undefined ? 'home' : 'scene');
}

export const TEMPLATE_MESSAGE = 'a recorded text held a {{…}} template, which a scenario would resolve (a var, an environment variable): left out — add the step by hand';
export const HIDDEN_MESSAGE =
  'a recorded text held a hidden character (a direction control, a zero-width or line-separator character): it would read as something else than it does, so the step is left out — add it by hand';

/** The main-target facts of a step whose target is `el`'s verified target (else nothing: no pick there). */
export function siteOf(el: El | null, target: TargetSpec | null, seqs: number[], site: NonNullable<StepMeta['site']>): Partial<StepMeta> {
  return target !== null && targetOf(el) !== null ? { target, targetSeqs: seqs, site } : target !== null ? { target } : {};
}

/** A scene's `open:` (a URL path and query: a `{{` is written percent-encoded, as the browser reads it). */
export function openOf(rel: string): string {
  const out = rel.replaceAll(TEMPLATE, '%7B%7B');
  return hidden(out) ? Array.from(out, (c) => (hidden(c) ? encodeURIComponent(c) : c)).join('') : out;
}

/** A press that closes an open list or popover without choosing anything (outside it, on nothing interactive). */
export function isClosingPress(e: Ev | undefined): boolean {
  return e?.kind === 'pointer' && (e.el === null || e.el.target === null || (e.el.role !== null && CONTAINER_ROLES.has(e.el.role)));
}

/** An event of a list (Radix / Base UI select, a multi-select popover): a press or typing inside the listbox it opened. */
export function inList(x: Ev | undefined): boolean {
  return !!x && (x.kind === 'pointer' || x.kind === 'type') && (x.el?.in === 'listbox' || x.el?.in === 'popover');
}
