/**
 * Edits of project.yaml's environments (R-ENV-06): add, change or remove one environment and move `default_env`, as
 * text. Each edit splices the text range of the node it changes — a page's value, a page's lines, a setting's line, the
 * environment's lines, `default_env`'s value — in the indentation of the file and the line endings of the lines it
 * lands next to, so every byte outside that range stays as it was (comments, CRLF, a 4-space indent, quoting). An
 * environment written on one line (`local: {app: …}`, or `environments: {…}` when one is added) is written again whole,
 * in block form: the comments inside it go. Nothing is written over an alias, an anchor or a merge key
 * (`<<:`) where the edit would land: the change would reach another node. The result is verified by reading it back:
 * the same data as the input with only `environments.<env>` and `default_env` changed, the environments in the same
 * order — else the edit is refused (edit the file by hand). Whether the result is a valid project.yaml is the caller's
 * check (parseProjectYaml, with the project's files).
 *
 * What needs a person (environmentEditAsks, R-ENV-07) and the lines a form and a result show (environmentEditLines)
 * are computed here from the data before and after; page URLs are never shown with their `user:password@`.
 */
import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify, visit } from 'yaml';
import type { Document, Node, Pair, YAMLMap } from 'yaml';
import { canonicalJson } from './canonical-json.js';
import { showHiddenCharsLine } from './printable.js';
import { canonicalAddress } from './navigation-policy.js';
import { isIosEnvironment, withoutCredentials } from './env.js';

/** A page as an edit gives it: its URL, or {url, display}. */
export type EnvironmentPageInput = string | { url: string; display?: string };

/** What to change in one environment (absent fields are left as they are). */
export interface EnvironmentChange {
  /** Pages added or replaced whole (a page given without display loses its display). */
  pages?: Record<string, EnvironmentPageInput>;
  /** Page keys removed. */
  remove_pages?: string[];
  production?: boolean;
  access?: 'read-only' | 'read-write';
  /** true: `default_env` names this environment; false: it no longer does (when it did). */
  default?: boolean;
}

/** `add` refuses an existing environment, `set` a missing one, `upsert` takes either. */
export type EnvironmentEditMode = 'add' | 'set' | 'upsert';

/** One environment as project.yaml declares it (the pages normalised to {url, display?}). */
export interface EnvironmentState {
  pages: Record<string, { url: string; display?: string }>;
  production?: boolean;
  access?: 'read-only' | 'read-write';
  /** It has a `read_only:` block (never written by these edits, kept as it is). */
  read_only?: true;
}

export interface EnvironmentEdit {
  /** project.yaml's new text (the input when nothing changes). */
  text: string;
  env: string;
  action: 'added' | 'changed' | 'removed' | 'unchanged';
  before: EnvironmentState | null;
  after: EnvironmentState | null;
  /** The environment a scenario without `env:` uses, before and after: `default_env`, else the first one. */
  default_before: string | null;
  default_after: string | null;
  /** Whether that environment is production or read-only, before and after. */
  default_protected_before: boolean;
  default_protected_after: boolean;
}

/** Why an edit cannot be made: `invalid` (the input), `not_found`, `refused` (a rule, a layout), `conflict` (add of an existing one). */
export class EnvironmentEditError extends Error {
  constructor(
    readonly kind: 'invalid' | 'not_found' | 'refused' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'EnvironmentEditError';
  }
}

type Json = Record<string, unknown>;
type Doc = Document.Parsed;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An environment of project.yaml's data in its normalised form, or null when it is not there. */
export function environmentState(file: unknown, env: string): EnvironmentState | null {
  const envs = isObj(file) && isObj(file.environments) ? file.environments : undefined;
  if (!envs || !Object.hasOwn(envs, env)) return null;
  const raw = envs[env];
  const long = isObj(raw) && Object.hasOwn(raw, 'pages');
  const pagesRaw = long ? (raw as Json).pages : raw;
  const pages: EnvironmentState['pages'] = {};
  for (const [k, v] of Object.entries(isObj(pagesRaw) ? pagesRaw : {})) {
    if (typeof v === 'string') pages[k] = { url: v };
    else if (isObj(v) && typeof v.url === 'string') pages[k] = { url: v.url, ...(typeof v.display === 'string' ? { display: v.display } : {}) };
  }
  const r = (long ? raw : {}) as Json;
  return {
    pages,
    ...(typeof r.production === 'boolean' ? { production: r.production } : {}),
    ...(r.access === 'read-only' || r.access === 'read-write' ? { access: r.access } : {}),
    ...(r.read_only !== undefined ? { read_only: true as const } : {}),
  };
}

/** An environment's protection: production, or read-only access (`access`, else read-only in production). */
export function environmentProtected(s: Pick<EnvironmentState, 'production' | 'access'> | null): boolean {
  return s !== null && (s.production === true || accessOf(s) === 'read-only');
}

/** The environment a scenario without `env:` uses: `default_env`, else the first environment, else the first sandbox. */
export function effectiveDefault(file: unknown): string | null {
  if (!isObj(file)) return null;
  if (typeof file.default_env === 'string') return file.default_env;
  const first = Object.keys(isObj(file.environments) ? file.environments : {})[0] ?? Object.keys(isObj(file.sandboxes) ? file.sandboxes : {})[0];
  return first ?? null;
}

/**
 * The origin two page URLs are compared by: scheme, host (lower case, no trailing dot, punycode, an IP literal in one
 * form) and port (the scheme's default written out). Null for what is not an http(s) URL.
 */
export function pageOrigin(url: string): string | null {
  const a = canonicalAddress(url);
  if (!a) return null;
  const scheme = new URL(url).protocol.slice(0, -1);
  return `${scheme}://${a.ip && a.host.includes(':') ? `[${a.host}]` : a.host}:${a.port}`;
}

/** A URL's `user:password@` as written (empty when it has none, or is no URL). */
export function urlUserinfo(url: string): string {
  try {
    const u = new URL(url);
    return u.username || u.password ? `${u.username}:${u.password}` : '';
  } catch {
    return '';
  }
}

/** A page URL as a form or a result shows it: without its `user:password@`, every hidden character written out. */
export function shownPageUrl(url: string): string {
  return showHiddenCharsLine(withoutCredentials(url).url);
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers: offsets of the parsed document, lines, splices.

const lineStart = (text: string, off: number): number => text.lastIndexOf('\n', off - 1) + 1;
/** The offset after the line break of the line holding `off` (the end of the text on the last line). */
const lineEnd = (text: string, off: number): number => {
  const i = text.indexOf('\n', off);
  return i < 0 ? text.length : i + 1;
};
const splice = (text: string, start: number, end: number, insert: string): string => text.slice(0, start) + insert + text.slice(end);
/** The offset after a node's last character that is not white space (its range ends after a block's line break). */
function contentEnd(text: string, node: Node): number {
  let e = node.range![1];
  while (e > node.range![0] && /\s/.test(text[e - 1])) e--;
  return e;
}
/** The text range of a pair's whole lines: its key's line to its value's last line, line break included. */
function pairLines(text: string, pair: Pair<Node, Node | null>): [number, number] {
  const key = pair.key as Node;
  const last = pair.value?.range ? contentEnd(text, pair.value) : key.range![1];
  return [lineStart(text, key.range![0]), lineEnd(text, Math.max(last - 1, key.range![0]))];
}
const column = (text: string, off: number): number => off - lineStart(text, off);
/**
 * The line ending of the lines around `off` (the line holding it, else the line before it): a file that mixes endings
 * gets the ones of the place the edit lands, never the first CRLF found elsewhere.
 */
function eolNear(text: string, off: number): string {
  const at = Math.min(Math.max(off, 0), text.length);
  for (const from of [at, lineStart(text, at) - 1]) {
    if (from < 0) continue;
    const nl = text.indexOf('\n', from);
    if (nl >= 0) return text[nl - 1] === '\r' ? '\r\n' : '\n';
  }
  const prev = text.lastIndexOf('\n');
  return prev > 0 && text[prev - 1] === '\r' ? '\r\n' : '\n';
}

/** Insert whole lines at `at` (a line start, or the end of the text): a text without a last line break gets one first. */
function insertLines(text: string, at: number, lines: string[], eol: string): string {
  const pre = at === text.length && text.length > 0 && !text.endsWith('\n') ? eol : '';
  return splice(text, at, at, pre + lines.map((l) => l + eol).join(''));
}

/** A scalar as YAML writes it on one line (quoted when a plain scalar would read as something else). */
function scalarText(v: string | boolean): string {
  return stringify(v, { lineWidth: 0 }).trimEnd();
}
/** A page value on one line: its URL, or `{url: …, display: …}`. */
function pageValueText(p: { url: string; display?: string }): string {
  return p.display === undefined ? scalarText(p.url) : stringify(p, { collectionStyle: 'flow', flowCollectionPadding: false, lineWidth: 0 }).trimEnd();
}
/** A mapping key on one line: plain when it reads back as the same string, else quoted. */
function keyText(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(k) ? k : JSON.stringify(k);
}

/** The lines of one environment entry in block form, at `indent`, each level `step` deeper. */
function entryLines(name: string, s: EnvironmentState, readOnly: unknown, indent: string, step: string): string[] {
  const pageLines = (at: string) => {
    const entries = Object.entries(s.pages);
    return entries.length ? entries.map(([k, p]) => `${at}${keyText(k)}: ${pageValueText(p)}`) : null;
  };
  const long = s.production !== undefined || s.access !== undefined || readOnly !== undefined;
  if (!long) {
    const pages = pageLines(indent + step);
    return pages ? [`${indent}${keyText(name)}:`, ...pages] : [`${indent}${keyText(name)}: {}`];
  }
  const inner = indent + step;
  const pages = pageLines(inner + step);
  const ro =
    readOnly === undefined
      ? []
      : stringify({ read_only: readOnly }, { indent: step.length, lineWidth: 0 })
          .trimEnd()
          .split('\n')
          .map((l) => inner + l);
  return [
    `${indent}${keyText(name)}:`,
    ...(s.production !== undefined ? [`${inner}production: ${s.production}`] : []),
    ...(s.access !== undefined ? [`${inner}access: ${s.access}`] : []),
    ...(pages ? [`${inner}pages:`, ...pages] : [`${inner}pages: {}`]),
    ...ro,
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the document.

function readDoc(text: string): Doc {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new EnvironmentEditError('invalid', `project.yaml cannot be read: ${doc.errors[0].message.split('\n')[0]}`);
  if (doc.contents !== null && (!isMap(doc.contents) || doc.contents.flow)) throw new EnvironmentEditError('refused', 'project.yaml is not a block mapping: edit it by hand');
  return doc;
}

function topPair(doc: Doc, key: string): Pair<Node, Node | null> | undefined {
  const m = doc.contents as YAMLMap<Node, Node | null> | null;
  return m?.items.find((p) => isScalar(p.key) && p.key.value === key);
}

function mapPair(map: YAMLMap<Node, Node | null>, key: string): Pair<Node, Node | null> | undefined {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
}

const sharedNode = (n: unknown): boolean => isAlias(n) || ((isMap(n) || isSeq(n) || isScalar(n)) && (n as { anchor?: string }).anchor !== undefined);

/**
 * Refuse an alias, an anchor or a merge key in `node` (`deep`: anywhere under it too): an edit there would reach
 * another node.
 */
function refuseShared(node: Node | null | undefined, where: string, deep = true): void {
  if (!node) return;
  const bad = sharedNode;
  let found = bad(node);
  if (!found && deep) {
    visit(node, {
      Node: (_k, n) => {
        if (bad(n)) {
          found = true;
          return visit.BREAK;
        }
        return undefined;
      },
      Pair: (_k, p) => {
        if (isScalar(p.key) && p.key.value === '<<') {
          found = true;
          return visit.BREAK;
        }
        return undefined;
      },
    });
  }
  if (found) throw new EnvironmentEditError('refused', `${where} of project.yaml uses an alias, an anchor or a merge key (<<): an edit there would change another node too — edit it by hand`);
}

/** A start line ending and the file's indentation step (the first key under `environments`, else two spaces). */
function layoutOf(text: string, envs: Node | null | undefined): { eol: string; step: string } {
  // Each edit picks the line ending of the lines it lands next to (eolNear); this is only a start value.
  const eol = eolNear(text, envs?.range?.[0] ?? text.length);
  const first = isMap(envs) && !envs.flow ? (envs.items[0]?.key as Node | undefined) : undefined;
  const col = first?.range ? column(text, first.range[0]) : 0;
  return { eol, step: ' '.repeat(col > 0 ? col : 2) };
}

// ---------------------------------------------------------------------------------------------------------------
// The edits, one at a time on the text (each re-reads it).

interface Ctx {
  text: string;
  env: string;
  eol: string;
  step: string;
}

function envsOf(doc: Doc): YAMLMap<Node, Node | null> | null {
  const v = topPair(doc, 'environments')?.value;
  return isMap(v) ? (v as YAMLMap<Node, Node | null>) : null;
}

/** Write a new environment entry at the end of `environments` (created when absent). */
function addEntry(c: Ctx, s: EnvironmentState): string {
  const doc = readDoc(c.text);
  const pair = topPair(doc, 'environments');
  refuseShared(pair?.value, '`environments`', false);
  const envs = envsOf(doc);
  c.eol = eolNear(c.text, pair ? (pair.key as Node).range![0] : c.text.length);
  if (envs && !envs.flow && envs.items.length) {
    const firstKey = envs.items[0].key as Node;
    const indent = ' '.repeat(column(c.text, firstKey.range![0]));
    const last = envs.items[envs.items.length - 1];
    return insertLines(c.text, pairLines(c.text, last)[1], entryLines(c.env, s, undefined, indent, c.step), c.eol);
  }
  const lines = entryLines(c.env, s, undefined, c.step, c.step);
  if (!pair) {
    // At the end, before a `...` document end marker.
    const all = c.text.split('\n');
    let end = all.length;
    while (end > 0 && !all[end - 1].trim()) end--;
    if (end > 0 && /^\.\.\.\s*(#.*)?\r?$/.test(all[end - 1])) end--;
    const at = all.slice(0, end).join('\n').length + (end > 0 && end < all.length ? 1 : 0);
    return insertLines(c.text, end === 0 ? 0 : at, ['environments:', ...lines], c.eol);
  }
  const keyEnd = (pair.key as Node).range![1];
  // `environments:` empty, `{}` or a flow mapping: its value written again in block form, the old entries first.
  const old = isMap(pair.value) ? (pair.value.toJSON() as Json) : {};
  const oldLines = Object.entries(old).flatMap(([name, v]) => {
    const st = environmentState({ environments: { [name]: v } }, name)!;
    return entryLines(name, st, isObj(v) && Object.hasOwn(v, 'pages') ? (v as Json).read_only : undefined, c.step, c.step);
  });
  const valueEnd = pair.value?.range ? contentEnd(c.text, pair.value) : keyEnd + 1;
  return splice(c.text, keyEnd + 1, valueEnd, c.eol + [...oldLines, ...lines].join(c.eol));
}

/** The environment's pair, checked: block layout under a block `environments`, no alias / anchor / merge key. */
function envPair(c: Ctx): { doc: Doc; pair: Pair<Node, Node | null> } {
  const doc = readDoc(c.text);
  refuseShared(topPair(doc, 'environments')?.value, '`environments`', false);
  const envs = envsOf(doc);
  const pair = envs ? mapPair(envs, c.env) : undefined;
  if (!envs || !pair) throw new EnvironmentEditError('not_found', `environment ${c.env} is not in project.yaml`);
  if (envs.flow) throw new EnvironmentEditError('refused', '`environments` of project.yaml is a flow mapping ({…}): edit it by hand');
  refuseShared(pair.key as Node, `environment ${c.env}`, false);
  refuseShared(pair.value, `environment ${c.env}`);
  c.eol = eolNear(c.text, (pair.key as Node).range![0]);
  return { doc, pair };
}

/** Write the environment entry again whole (a flow layout, an empty page map), in block form at its own indent. */
function rewriteEntry(c: Ctx, s: EnvironmentState, readOnly: unknown): string {
  const { pair } = envPair(c);
  const [start, end] = pairLines(c.text, pair);
  const indent = ' '.repeat(column(c.text, (pair.key as Node).range![0]));
  const lines = entryLines(c.env, s, readOnly, indent, c.step);
  return splice(c.text, start, end, lines.map((l) => l + c.eol).join(''));
}

/** The block map of the pages of an environment entry (null: a flow or odd layout). */
function pagesMap(pair: Pair<Node, Node | null>): { map: YAMLMap<Node, Node | null>; long: boolean } | null {
  const v = pair.value;
  if (!isMap(v) || v.flow) return null;
  const pages = mapPair(v as YAMLMap<Node, Node | null>, 'pages');
  if (!pages) return { map: v as YAMLMap<Node, Node | null>, long: false };
  return isMap(pages.value) && !pages.value.flow && pages.value.items.length ? { map: pages.value as YAMLMap<Node, Node | null>, long: true } : null;
}

/** The short form turned into the long form: its page lines one level deeper under a `pages:` line. */
function toLongForm(c: Ctx): string {
  const { pair } = envPair(c);
  const pm = pagesMap(pair);
  if (!pm || pm.long) return c.text;
  const first = pm.map.items[0].key as Node;
  const start = lineStart(c.text, first.range![0]);
  const end = pairLines(c.text, pm.map.items[pm.map.items.length - 1])[1];
  const indent = c.text.slice(start, first.range![0]);
  const deeper = c.text
    .slice(start, end)
    .split('\n')
    .map((l) => (l.replace(/\r$/, '').trim() ? c.step + l : l))
    .join('\n');
  return splice(c.text, start, end, `${indent}pages:${c.eol}${deeper}`);
}

/** Set (or, `value` undefined, remove) `production` / `access` in a long-form entry. */
function setSetting(c: Ctx, key: 'production' | 'access', value: string | boolean | undefined): string {
  const { pair } = envPair(c);
  const map = pair.value as YAMLMap<Node, Node | null>;
  const at = mapPair(map, key);
  if (at) {
    if (value === undefined) return splice(c.text, ...pairLines(c.text, at), '');
    if (!isScalar(at.value) || !at.value.range) return splice(c.text, ...pairLines(c.text, at), `${c.text.slice(lineStart(c.text, (at.key as Node).range![0]), (at.key as Node).range![0])}${key}: ${scalarText(value)}${c.eol}`);
    return splice(c.text, at.value.range[0], at.value.range[1], scalarText(value));
  }
  if (value === undefined) return c.text;
  const first = map.items[0].key as Node;
  const ls = lineStart(c.text, first.range![0]);
  return insertLines(c.text, ls, [`${c.text.slice(ls, first.range![0])}${key}: ${scalarText(value)}`], c.eol);
}

/** Add or replace one page of a block page map. */
function setPage(c: Ctx, key: string, page: { url: string; display?: string }): string {
  const { pair } = envPair(c);
  const pm = pagesMap(pair)!;
  const at = mapPair(pm.map, key);
  const value = pageValueText(page);
  if (at) {
    // A one-line value: only its text (a comment after it stays); else the page's lines.
    if (at.value?.range && (isScalar(at.value) || (isMap(at.value) && at.value.flow)) && !c.text.slice(at.value.range[0], at.value.range[1]).includes('\n')) {
      return splice(c.text, at.value.range[0], at.value.range[1], value);
    }
    const ks = (at.key as Node).range![0];
    return splice(c.text, ...pairLines(c.text, at), `${c.text.slice(lineStart(c.text, ks), ks)}${keyText(key)}: ${value}${c.eol}`);
  }
  const first = pm.map.items[0].key as Node;
  const indent = c.text.slice(lineStart(c.text, first.range![0]), first.range![0]);
  return insertLines(c.text, pairLines(c.text, pm.map.items[pm.map.items.length - 1])[1], [`${indent}${keyText(key)}: ${value}`], c.eol);
}

function removePage(c: Ctx, key: string): string {
  const { pair } = envPair(c);
  const at = mapPair(pagesMap(pair)!.map, key);
  return at ? splice(c.text, ...pairLines(c.text, at), '') : c.text;
}

/** `default_env: <env>` (or, `env` null, no `default_env`), written after `environments` when it is new. */
function setDefault(c: Ctx, env: string | null): string {
  const doc = readDoc(c.text);
  const at = topPair(doc, 'default_env');
  refuseShared(at?.value, '`default_env`');
  const near = at ?? topPair(doc, 'environments');
  c.eol = eolNear(c.text, near ? (near.key as Node).range![0] : c.text.length);
  if (at) {
    if (env === null) return splice(c.text, ...pairLines(c.text, at), '');
    if (isScalar(at.value) && at.value.range && !c.text.slice(at.value.range[0], at.value.range[1]).includes('\n')) return splice(c.text, at.value.range[0], at.value.range[1], keyText(env));
    return splice(c.text, ...pairLines(c.text, at), `default_env: ${keyText(env)}${c.eol}`);
  }
  if (env === null) return c.text;
  const envs = topPair(doc, 'environments');
  const where = envs ? pairLines(c.text, envs)[1] : c.text.length;
  return insertLines(c.text, where, [`default_env: ${keyText(env)}`], c.eol);
}

function removeEntry(c: Ctx): string {
  const { doc, pair } = envPair(c);
  const envs = envsOf(doc)!;
  // The last environment: `environments` goes with it (a project of sandboxes only).
  const whole = envs.items.length === 1 ? topPair(doc, 'environments')! : pair;
  return splice(c.text, ...pairLines(c.text, whole), '');
}

// ---------------------------------------------------------------------------------------------------------------
// The edit as a whole.

function pageOf(p: EnvironmentPageInput): { url: string; display?: string } {
  // Trimmed: what a command line (`retake env … --page key=url`) can say back.
  return typeof p === 'string' ? { url: p.trim() } : { url: p.url.trim(), ...(p.display !== undefined ? { display: p.display.trim() } : {}) };
}

function nextState(before: EnvironmentState | null, change: EnvironmentChange): EnvironmentState {
  const pages = { ...(before?.pages ?? {}) };
  for (const k of change.remove_pages ?? []) delete pages[k];
  for (const [k, p] of Object.entries(change.pages ?? {})) pages[k] = pageOf(p);
  const production = change.production ?? before?.production;
  // Production off, nothing said about access: the access it had stays (production implied read-only).
  const keptReadOnly = before?.production === true && change.production === false && change.access === undefined && before.access === undefined;
  const access = change.access ?? before?.access ?? (keptReadOnly ? 'read-only' : undefined);
  return {
    pages,
    ...(production !== undefined && !(production === false && before?.production === undefined) ? { production } : {}),
    ...(access !== undefined ? { access } : {}),
    ...(before?.read_only ? { read_only: true as const } : {}),
  };
}

/** The data project.yaml should read back as: the input's, with `environments.<env>` and `default_env` as edited. */
function expectedFile(file: Json, env: string, after: EnvironmentState | null, defaultEnv: string | null | undefined): Json {
  const out: Json = { ...file };
  const envs: Json = { ...(isObj(file.environments) ? file.environments : {}) };
  if (after === null) delete envs[env];
  else {
    const old = envs[env];
    const readOnly = isObj(old) && Object.hasOwn(old, 'pages') ? (old as Json).read_only : undefined;
    const pages = Object.fromEntries(Object.entries(after.pages).map(([k, p]) => [k, p.display === undefined ? p.url : { url: p.url, display: p.display }]));
    const long = after.production !== undefined || after.access !== undefined || readOnly !== undefined;
    envs[env] = long
      ? { ...(after.production !== undefined ? { production: after.production } : {}), ...(after.access ? { access: after.access } : {}), pages, ...(readOnly !== undefined ? { read_only: readOnly } : {}) }
      : pages;
  }
  if (Object.keys(envs).length) out.environments = envs;
  else delete out.environments;
  if (defaultEnv === null) delete out.default_env;
  else if (defaultEnv !== undefined) out.default_env = defaultEnv;
  return out;
}

function verify(text: string, expected: Json): void {
  const got = parseDocument(text);
  const js = (got.errors.length ? undefined : got.toJS()) as Json | undefined;
  const order = (f: Json | undefined) => Object.keys(isObj(f?.environments) ? f!.environments : {}).join('\n');
  if (!js || canonicalJson(js) !== canonicalJson(expected) || order(js) !== order(expected)) {
    throw new EnvironmentEditError('refused', "project.yaml's layout around its environments could not be edited without changing something else: edit it by hand");
  }
}

function fileOf(text: string): Json {
  const js = readDoc(text).toJS() as unknown;
  return isObj(js) ? js : {};
}

function result(text: string, edited: string, e: Pick<EnvironmentEdit, 'env' | 'action' | 'before' | 'after'>): EnvironmentEdit {
  const { env, action, before, after } = e;
  const fb = fileOf(text);
  const fa = action === 'unchanged' ? fb : fileOf(edited);
  const db = effectiveDefault(fb);
  const da = effectiveDefault(fa);
  return {
    text: edited,
    env,
    action,
    before,
    after,
    default_before: db,
    default_after: da,
    default_protected_before: db !== null && environmentProtected(environmentState(fb, db)),
    default_protected_after: da !== null && environmentProtected(environmentState(fa, da)),
  };
}

/** An iOS environment (`ios:`) has no pages to set: it is edited by hand in project.yaml, never here. */
function refuseIos(file: Json, env: string): void {
  const envs = isObj(file.environments) ? file.environments : {};
  if (Object.hasOwn(envs, env) && isIosEnvironment(envs[env])) {
    throw new EnvironmentEditError('refused', `environment ${env} is an iOS environment (\`ios:\`): it has no pages — edit it in project.yaml by hand`);
  }
}

function checkChange(change: EnvironmentChange): void {
  const set = Object.keys(change.pages ?? {});
  const both = (change.remove_pages ?? []).filter((k) => set.includes(k));
  if (both.length) throw new EnvironmentEditError('invalid', `page ${both[0]} is both set and removed: give it once`);
  for (const [k, p] of Object.entries(change.pages ?? {})) {
    // `retake env … --page key=url,display=host` could not say it back.
    if (pageOf(p).url.includes(',display=')) throw new EnvironmentEditError('invalid', `page ${k}: a URL that contains ",display=" cannot be written here: edit project.yaml by hand`);
  }
}

/**
 * project.yaml's text with one environment added or changed (`change`), `default_env` moved when `change.default` says
 * so. Refuses (EnvironmentEditError) a missing environment for `set`, an existing one for `add`, a layout it cannot
 * edit in place; the result is not validated as a project (the caller's parseProjectYaml).
 */
export function editEnvironment(text: string, env: string, change: EnvironmentChange, mode: EnvironmentEditMode): EnvironmentEdit {
  checkChange(change);
  const file = fileOf(text);
  refuseIos(file, env);
  const before = environmentState(file, env);
  if (before === null && mode === 'set') throw new EnvironmentEditError('not_found', `environment ${env} is not in project.yaml (environments: ${Object.keys(isObj(file.environments) ? file.environments : {}).join(', ') || 'none'})`);
  if (before !== null && mode === 'add') throw new EnvironmentEditError('conflict', `environment ${env} is already in project.yaml: change it with set`);
  const missing = before ? (change.remove_pages ?? []).filter((k) => !Object.hasOwn(before.pages, k)) : (change.remove_pages ?? []);
  if (missing.length) throw new EnvironmentEditError('not_found', `environment ${env} has no page ${missing[0]}`);
  const after = nextState(before, change);
  if (!Object.keys(after.pages).length) {
    throw new EnvironmentEditError('invalid', before ? `environment ${env} would have no page left: remove the environment instead` : `environment ${env} needs at least one page`);
  }
  if (before === null && /^\d+$/.test(env)) {
    // An integer-like key comes first in a mapping's data: it would become the implicit default environment.
    throw new EnvironmentEditError('invalid', `environment name ${env} is a number: give it a name with a letter (a number would come first and become the default)`);
  }
  const declared = typeof file.default_env === 'string' ? file.default_env : undefined;
  const defaultEnv = change.default === true ? env : change.default === false && declared === env ? null : undefined;
  const expected = expectedFile(file, env, after, defaultEnv);
  if (canonicalJson(expected) === canonicalJson(file)) return result(text, text, { env, action: 'unchanged', before, after: before });
  const { eol, step } = layoutOf(text, topPair(readDoc(text), 'environments')?.value);
  const c: Ctx = { text, env, eol, step };
  if (before === null) c.text = addEntry(c, after);
  else {
    const { pair } = envPair(c);
    const readOnly = isObj((file.environments as Json)[env]) && Object.hasOwn((file.environments as Json)[env] as Json, 'pages') ? ((file.environments as Json)[env] as Json).read_only : undefined;
    // A flow layout, or a page map that would be or is empty: the entry written again whole.
    if (!pagesMap(pair) || !Object.keys(after.pages).length) c.text = rewriteEntry(c, after, readOnly);
    else {
      if (after.production !== before.production || after.access !== before.access) {
        c.text = toLongForm(c);
        if (after.access !== before.access) c.text = setSetting(c, 'access', after.access);
        if (after.production !== before.production) c.text = setSetting(c, 'production', after.production);
      }
      for (const [k, p] of Object.entries(change.pages ?? {})) c.text = setPage(c, k, pageOf(p));
      for (const k of change.remove_pages ?? []) c.text = removePage(c, k);
    }
  }
  if (defaultEnv !== undefined) c.text = setDefault(c, defaultEnv);
  verify(c.text, expected);
  return result(text, c.text, { env, action: before === null ? 'added' : 'changed', before, after });
}

/** project.yaml's text without environment `env` (and without `default_env` when it named it). */
export function removeEnvironment(text: string, env: string): EnvironmentEdit {
  const file = fileOf(text);
  refuseIos(file, env);
  const before = environmentState(file, env);
  if (before === null) throw new EnvironmentEditError('not_found', `environment ${env} is not in project.yaml (environments: ${Object.keys(isObj(file.environments) ? file.environments : {}).join(', ') || 'none'})`);
  const { eol, step } = layoutOf(text, topPair(readDoc(text), 'environments')?.value);
  const c: Ctx = { text, env, eol, step };
  const named = file.default_env === env;
  const expected = expectedFile(file, env, null, named ? null : undefined);
  c.text = removeEntry(c);
  if (named) c.text = setDefault(c, null);
  verify(c.text, expected);
  return result(text, c.text, { env, action: 'removed', before, after: null });
}

/** A top-level string of a YAML mapping (a scenario's `env:`), or undefined (none, another type, a text that does not read). */
export function topLevelString(text: string, key: string): string | undefined {
  const doc = parseDocument(text);
  const v = doc.errors.length || !isMap(doc.contents) ? undefined : doc.get(key);
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// What needs a person, and the lines that show the change.

/** One reason a change needs a person (R-ENV-07): a fixed kind and its line. */
export interface EnvironmentAsk {
  kind: 'new_origin' | 'lowers' | 'default' | 'userinfo';
  line: string;
}

/**
 * What in an edit needs a person, from the data alone: a page on an origin none of the project's environments has
 * (`origins`: the project's page origins before the edit, pageOrigin's form); a protection lowered (production or
 * read-only removed, a protected environment removed, a page of a protected environment removed or moved, a production
 * environment that allows writes — a new one included); the
 * environment a scenario without `env:` uses becoming a protected one; a page URL whose `user:password@` changes.
 */
export function environmentEditAsks(edit: EnvironmentEdit, origins: readonly string[]): EnvironmentAsk[] {
  const asks: EnvironmentAsk[] = [];
  const { before, after, env } = edit;
  const known = new Set(origins);
  for (const [k, p] of Object.entries(after?.pages ?? {})) {
    const was = before?.pages[k];
    const o = pageOrigin(p.url);
    if (o && !known.has(o) && was?.url !== p.url) asks.push({ kind: 'new_origin', line: `page ${k} reaches ${o}, an origin no environment of the project has` });
    const ui = urlUserinfo(p.url);
    if (ui && ui !== urlUserinfo(was?.url ?? '')) asks.push({ kind: 'userinfo', line: `page ${k}'s URL carries sign-in details (user:password@, not shown)` });
  }
  // Production that allows writes (access: read-write): a run may write to its hosts with --allow-writes.
  const writableProduction = (x: EnvironmentState | null) => x?.production === true && accessOf(x) === 'read-write';
  if (writableProduction(after) && !writableProduction(before) && !environmentProtected(before)) asks.push({ kind: 'lowers', line: `environment ${env} is production and allows writes (access: read-write)` });
  if (environmentProtected(before)) {
    if (!after) asks.push({ kind: 'lowers', line: `environment ${env} is ${protectionWords(before)}: removing it` });
    else {
      if (before!.production === true && after.production !== true) asks.push({ kind: 'lowers', line: `environment ${env} is no longer production` });
      if (accessOf(before) === 'read-only' && accessOf(after) === 'read-write') asks.push({ kind: 'lowers', line: `environment ${env} becomes read-write` });
      for (const [k, p] of Object.entries(before!.pages)) {
        if (!after.pages[k]) asks.push({ kind: 'lowers', line: `page ${k} of ${protectionWords(before)} environment ${env} is removed` });
        else if (after.pages[k].url !== p.url) asks.push({ kind: 'lowers', line: `page ${k} of ${protectionWords(before)} environment ${env} moves to another URL` });
      }
    }
  }
  if (edit.default_after !== null && edit.default_after !== edit.default_before && edit.default_protected_after) {
    asks.push({ kind: 'default', line: `scenarios without env: would run on ${edit.default_after}, a production or read-only environment (was ${edit.default_before ?? 'none'})` });
  }
  return asks;
}

function accessOf(s: Pick<EnvironmentState, 'production' | 'access'> | null): 'read-only' | 'read-write' {
  return s?.access ?? (s?.production === true ? 'read-only' : 'read-write');
}

function protectionWords(s: EnvironmentState | null): string {
  return s?.production === true ? 'a production' : 'a read-only';
}

function stateWords(s: EnvironmentState): string {
  return `${s.production === true ? 'production, ' : ''}${accessOf(s)}`;
}

function pageWords(p: { url: string; display?: string }): string {
  return `${shownPageUrl(p.url)}${urlUserinfo(p.url) ? ' (with sign-in details)' : ''}${p.display !== undefined ? ` (shown as ${showHiddenCharsLine(p.display)})` : ''}`;
}

/** The change as lines a person reads (a form, a result): no `user:password@`, every hidden character written out. */
export function environmentEditLines(edit: EnvironmentEdit): string[] {
  const { before, after, env } = edit;
  const lines: string[] = [];
  if (edit.action === 'unchanged') lines.push(`environment ${env}: nothing to change`);
  else if (!before && after) {
    lines.push(`add environment ${env} (${stateWords(after)})`);
    for (const [k, p] of Object.entries(after.pages)) lines.push(`page ${k}: ${pageWords(p)}`);
  } else if (before && !after) {
    lines.push(`remove environment ${env} (${stateWords(before)}; pages ${Object.keys(before.pages).join(', ') || 'none'})`);
  } else if (before && after) {
    lines.push(`change environment ${env}`);
    if (before.production !== after.production) lines.push(`production: ${before.production === true ? 'yes' : 'no'} → ${after.production === true ? 'yes' : 'no'}`);
    if (accessOf(before) !== accessOf(after)) lines.push(`access: ${accessOf(before)} → ${accessOf(after)}`);
    for (const [k, p] of Object.entries(after.pages)) {
      const was = before.pages[k];
      if (!was) lines.push(`add page ${k}: ${pageWords(p)}`);
      else if (was.url !== p.url || was.display !== p.display) lines.push(`page ${k}: ${pageWords(was)} → ${pageWords(p)}`);
    }
    for (const k of Object.keys(before.pages)) if (!after.pages[k]) lines.push(`remove page ${k} (was ${pageWords(before.pages[k])})`);
  }
  if (edit.default_before !== edit.default_after) lines.push(`default environment (scenarios without env:): ${edit.default_before ?? 'none'} → ${edit.default_after ?? 'none'}`);
  return lines;
}
